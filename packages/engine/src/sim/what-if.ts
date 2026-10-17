import type { Environment, Problem, Workload } from "@archdrill/model";
import type { SimulationContext } from "./setup";
import { simulateEnvironment } from "./simulate";
import type { EnvironmentMetrics } from "./types";

/** Most traffic the search for a breaking point tries, as a multiple of the environment's. */
export const MAX_TRAFFIC_FACTOR = 100;
/** The search stops once the last factor that held and the first that broke are this close. */
const BREAK_PRECISION = 1.01;
/** Each step up while looking for a factor that breaks. */
const SEARCH_STEP = 1.5;
/** Below this share of successful requests an operation counts as broken. */
export const BREAK_SUCCESS = 0.999;
/** Calls given up on below this share are noise, not a cause. */
const LIMIT_TOLERANCE = 1e-4;
/** Backlog growth above this share of the arrival rate counts as falling behind. */
const BACKLOG_TOLERANCE = 1e-3;

/**
 * The environment with its users' traffic multiplied: every request
 * operation's rate and the clients holding connections. Scheduled jobs keep
 * their rate (they follow the data, not the traffic), and consumers follow
 * whatever is published to them.
 */
export function scaledEnvironment(
  environment: Environment,
  factor: number,
  problem: Problem,
): Environment {
  const requests = new Set(
    problem.operations.filter((o) => o.trigger.type === "request").map((o) => o.id),
  );
  return {
    ...environment,
    connections: environment.connections * factor,
    rates: Object.fromEntries(
      Object.entries(environment.rates).map(([id, rate]) => [
        id,
        requests.has(id) ? rate * factor : rate,
      ]),
    ),
  };
}

/** What gives first under a load: components over capacity, operations failing or falling behind. */
export interface Breakage {
  /** Busiest first, with the utilisation of their busiest shard. */
  readonly overloaded: readonly { readonly componentId: string; readonly utilization: number }[];
  readonly failing: readonly { readonly operation: string; readonly successRate: number }[];
  /** Consumers and jobs whose backlog grows. */
  readonly behind: readonly string[];
  /** The load model did not settle: something keeps tipping over, so nothing here is steady. */
  readonly unsettled: boolean;
  /**
   * Calls a caller gives up on before they reach a component that may itself
   * have room: shed by a bulkhead, left waiting by a pool, or timed out. The
   * largest share first.
   */
  readonly limited: readonly {
    readonly connectionId: string;
    readonly by: "bulkhead" | "pool" | "timeout";
    readonly share: number;
  }[];
}

/** How a load breaks the design, judged on the given operations; null when it holds. */
export function breakageOf(
  metrics: EnvironmentMetrics,
  operations: readonly string[],
): Breakage | null {
  const overloaded = [...metrics.components.values()]
    .map((c) => ({
      componentId: c.componentId,
      utilization: Math.max(c.utilization, c.hottestShardUtilization),
    }))
    .filter((c) => c.utilization > 1)
    .sort((a, b) => b.utilization - a.utilization);
  const judged = operations.flatMap((id) => {
    const op = metrics.operations.get(id);
    return op && op.rate > 0 ? [op] : [];
  });
  const failing = judged
    .filter((op) => op.successRate < BREAK_SUCCESS)
    .map((op) => ({ operation: op.operation, successRate: op.successRate }));
  const behind = judged
    .filter((op) => op.trigger !== "request" && op.backlogGrowth > BACKLOG_TOLERANCE * op.rate)
    .map((op) => op.operation);
  const unsettled = !metrics.converged;
  if (overloaded.length + failing.length + behind.length === 0 && !unsettled) return null;
  const limited = [
    ...[...metrics.calls.values()].flatMap((c) => [
      { connectionId: c.connectionId, by: "bulkhead" as const, share: c.shed },
      { connectionId: c.connectionId, by: "timeout" as const, share: c.timedOut },
    ]),
    ...[...metrics.pools.values()].map((p) => ({
      connectionId: p.connectionId,
      by: "pool" as const,
      share: p.exhausted,
    })),
  ]
    .filter((l) => l.share > LIMIT_TOLERANCE)
    .sort((a, b) => b.share - a.share);
  return { overloaded, failing, behind, limited, unsettled };
}

export interface BreakingPoint {
  /** The first multiple of the environment's traffic that breaks it; null if none up to the most tried. */
  readonly factor: number | null;
  /** The largest multiple tried that held; 0 when the environment's own traffic already breaks it. */
  readonly holds: number;
  /** What gives at `factor`. */
  readonly breakage: Breakage | null;
}

/**
 * The multiple of an environment's traffic at which the design first breaks:
 * stepping up until a load breaks it, then halving the distance between the
 * last that held and the first that broke. It assumes more traffic never
 * helps; a design that breaks and recovers in between (retries, autoscaling
 * limits) can break earlier than the multiple it reports.
 */
export function findBreakingPoint(
  workload: Workload,
  environment: Environment,
  ctx: SimulationContext,
  operations: readonly string[],
): BreakingPoint {
  const at = (factor: number) =>
    breakageOf(
      simulateEnvironment(workload, scaledEnvironment(environment, factor, ctx.problem), ctx),
      operations,
    );
  const now = at(1);
  if (now) return { factor: 1, holds: 0, breakage: now };
  let holds = 1;
  let breaks = Math.min(MAX_TRAFFIC_FACTOR, SEARCH_STEP);
  let breakage = at(breaks);
  while (!breakage) {
    if (breaks >= MAX_TRAFFIC_FACTOR) return { factor: null, holds: breaks, breakage: null };
    holds = breaks;
    breaks = Math.min(MAX_TRAFFIC_FACTOR, breaks * SEARCH_STEP);
    breakage = at(breaks);
  }
  while (breaks / holds > BREAK_PRECISION) {
    const middle = Math.sqrt(holds * breaks);
    const found = at(middle);
    if (found) {
      breaks = middle;
      breakage = found;
    } else {
      holds = middle;
    }
  }
  return { factor: breaks, holds, breakage };
}
