import {
  ACTIONS,
  type Connection,
  DEFAULT_POLICY,
  type Environment,
  type Workload,
} from "@archdrill/model";
import type { CallPathStep } from "../paths/types";
import { cacheHitRatio } from "./cache-model";
import { type CallModel, callModel } from "./calls";
import type { ComponentProfile } from "./capacity";
import { type ComponentFault, NO_FAULT, resolveFaults } from "./faults";
import { callShare, type OutcomeState } from "./outcomes";
import {
  buildCacheSpecs,
  buildOperations,
  buildProfiles,
  type CacheSpec,
  cacheKey,
  type OperationModel,
  occupancies,
  replicaAckMs,
  type SimulationContext,
  storedGb,
} from "./setup";
import {
  type CallTally,
  componentLatency,
  dropFor,
  type Load,
  type Propagation,
  pathProbability,
  summarizeCache,
  summarizeCalls,
  summarizeComponents,
  summarizeOperations,
  timeoutShare,
} from "./summary";
import type { EnvironmentMetrics } from "./types";

export { NETWORK_RTT_MS } from "./calls";
export { CACHE_FILL_FACTOR, type SimulationContext } from "./setup";
export { OVERLOAD_WAIT_MS } from "./summary";

const MAX_ITERATIONS = 100;
const TOLERANCE = 1e-7;
const DAMPING = 0.5;

/** Quantities the fixed point iterates on, each relaxed with damping. */
interface LoopState {
  /** Per component: share of arrivals rejected by overload. */
  readonly drop: Map<string, number>;
  /** Per connection: share of served attempts that exceed the caller's timeout. */
  readonly timedOut: Map<string, number>;
  /** Per connection: share of attempts the caller's bulkhead rejects. */
  readonly shed: Map<string, number>;
  readonly hit: Map<string, number>;
  readonly negativeHit: Map<string, number>;
}

/**
 * Steady-state model of one environment: load propagation over path
 * probabilities, cache hit ratios, queueing latency, overload, faults, and the
 * callers' timeouts, retries, circuit breakers and bulkheads. These feed back
 * on each other (a failing call takes the error branch and may be retried,
 * which shifts load), so the model iterates to a damped fixed point. If it
 * does not settle, the metrics are the last iterate and `converged` is false.
 */
export function simulateEnvironment(
  workload: Workload,
  environment: Environment,
  ctx: SimulationContext,
): EnvironmentMetrics {
  const faults = resolveFaults(environment.faults, ctx.attempt, ctx.catalog);
  const profiles = buildProfiles(ctx, faults);
  const operations = buildOperations(workload, environment, ctx);
  const caches = buildCacheSpecs(workload, profiles, ctx);
  const connections = ctx.attempt.architecture.connections;
  const loop: LoopState = {
    drop: new Map(),
    timedOut: new Map(),
    shed: new Map(),
    hit: new Map(),
    negativeHit: new Map(),
  };
  const calls = callModels(connections, faults, loop);
  const occupancyByEntity = occupancies(workload, ctx);
  const state: OutcomeState = {
    callFailure: (step) => calls.get(step).failure,
    occupancy: (entity) => occupancyByEntity.get(entity ?? "")?.all ?? 0,
    aliasOccupancy: (entity) => occupancyByEntity.get(entity ?? "")?.aliases ?? 0,
    hitRatio: (id, entity) => loop.hit.get(cacheKey(id, entity)) ?? 0,
    negativeHitRatio: (id, entity) => loop.negativeHit.get(cacheKey(id, entity)) ?? 0,
  };
  const ingress = ingressModel(faults, loop);

  let iterations = 0;
  let converged = false;
  while (iterations < MAX_ITERATIONS) {
    iterations++;
    calls.reset();
    const flow = propagate(operations, state, calls.get, ingress, loop.shed);
    const delta = Math.max(
      relaxComponents(profiles, flow, loop),
      relaxConnections(connections, profiles, flow, loop),
      relaxCaches(caches, flow, loop),
    );
    if (delta < TOLERANCE) {
      converged = true;
      break;
    }
  }

  calls.reset();
  const final = propagate(operations, state, calls.get, ingress, loop.shed);
  const components = summarizeComponents(
    profiles,
    final,
    loop.drop,
    storedGb(workload, ctx),
    faults,
  );
  return {
    environment,
    operations: summarizeOperations(operations, state, ingress.pass, {
      components,
      callFor: calls.get,
      replicaAck: replicaAckMs(workload, ctx),
    }),
    components,
    caches: caches.map((spec) => summarizeCache(spec, final, state)),
    connections: final.traffic,
    calls: summarizeCalls(final, loop.shed, loop.timedOut),
    monthlyCost: [...components.values()].reduce((sum, c) => sum + c.monthlyCost, 0),
    converged,
    iterations,
  };
}

function relax(values: Map<string, number>, key: string, target: number): number {
  const current = values.get(key) ?? 0;
  const next = current + DAMPING * (target - current);
  values.set(key, next);
  return Math.abs(next - current);
}

function relaxComponents(
  profiles: ReadonlyMap<string, ComponentProfile>,
  flow: Propagation,
  loop: LoopState,
): number {
  let delta = 0;
  for (const [id, profile] of profiles) {
    delta = Math.max(delta, relax(loop.drop, id, dropFor(flow.loads.get(id), profile)));
  }
  return delta;
}

/** Timeouts follow the target's latency; the bulkhead sheds what exceeds its rate. */
function relaxConnections(
  connections: readonly Connection[],
  profiles: ReadonlyMap<string, ComponentProfile>,
  flow: Propagation,
  loop: LoopState,
): number {
  let delta = 0;
  for (const connection of connections) {
    const { timeoutMs, maxRps } = connection.policy;
    const profile = profiles.get(connection.to);
    if (timeoutMs !== undefined && profile) {
      const latency = componentLatency(flow.loads.get(connection.to), profile);
      delta = Math.max(
        delta,
        relax(loop.timedOut, connection.id, timeoutShare(latency, timeoutMs)),
      );
    }
    if (maxRps !== undefined) {
      const offered = flow.calls.get(connection.id)?.attempts ?? 0;
      const target = offered > maxRps ? 1 - maxRps / offered : 0;
      delta = Math.max(delta, relax(loop.shed, connection.id, target));
    }
  }
  return delta;
}

function relaxCaches(caches: readonly CacheSpec[], flow: Propagation, loop: LoopState): number {
  let delta = 0;
  for (const spec of caches) {
    const key = cacheKey(spec.componentId, spec.entity);
    const lookups = flow.lookups.get(key) ?? { existing: 0, absent: 0 };
    const [positiveItems, negativeItems] = splitCapacity(spec, lookups);
    delta = Math.max(delta, relax(loop.hit, key, hitFor(spec, lookups.existing, positiveItems)));
    delta = Math.max(
      delta,
      relax(loop.negativeHit, key, negativeHitFor(spec, lookups.absent, negativeItems)),
    );
  }
  return delta;
}

/**
 * Call models per (connection, reads or writes), rebuilt once per iteration
 * from the current overload, timeout and shedding shares.
 */
function callModels(
  connections: readonly Connection[],
  faults: ReadonlyMap<string, ComponentFault>,
  loop: LoopState,
) {
  const policies = new Map(connections.map((c) => [c.id, c.policy]));
  const memo = new Map<string, CallModel>();
  const get = (step: CallPathStep): CallModel => {
    const write = ACTIONS[step.action].effect !== "read";
    const connection = step.connectionId ?? `-${step.target}`;
    const key = `${connection}|${write ? "w" : "r"}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const fault = faults.get(step.target) ?? NO_FAULT;
    const model = callModel(
      {
        shed: loop.shed.get(connection) ?? 0,
        fault: write ? fault.failWrite : fault.failRead,
        faultHangs: fault.hang,
        overload: loop.drop.get(step.target) ?? 0,
        timeout: loop.timedOut.get(connection) ?? 0,
      },
      policies.get(connection) ?? DEFAULT_POLICY,
    );
    memo.set(key, model);
    return model;
  };
  return { get, reset: () => memo.clear() };
}

/** How ingress hops lose requests: overload and faults on the components along the route. */
function ingressModel(faults: ReadonlyMap<string, ComponentFault>, loop: LoopState) {
  const overload = (id: string) => loop.drop.get(id) ?? 0;
  const lost = (id: string, write: boolean) => {
    const fault = faults.get(id) ?? NO_FAULT;
    return write ? fault.failWrite : fault.failRead;
  };
  const pass = (op: OperationModel) => {
    const write = op.operation.class === "write";
    return op.ingress.reduce((share, id) => share * (1 - overload(id)) * (1 - lost(id, write)), 1);
  };
  return { overload, lost, pass };
}

type IngressModel = ReturnType<typeof ingressModel>;

/**
 * Positive and negative entries compete for the same memory. Without negative
 * caching all of it holds positive entries; with it, memory is shared in
 * proportion to lookups, a simple and documented approximation.
 */
function splitCapacity(
  spec: CacheSpec,
  lookups: { existing: number; absent: number },
): [number, number] {
  if (!spec.negativePopulated) return [spec.capacityItems, 0];
  const total = lookups.existing + lookups.absent;
  if (total <= 0) return [spec.capacityItems, 0];
  const negativeShare = lookups.absent / total;
  return [spec.capacityItems * (1 - negativeShare), spec.capacityItems * negativeShare];
}

function hitFor(spec: CacheSpec, rate: number, capacityItems: number): number {
  if (!spec.populated || !spec.existing) return 0;
  return cacheHitRatio({ rate, popularity: spec.existing, capacityItems, ttlSec: spec.ttlSec });
}

function negativeHitFor(spec: CacheSpec, rate: number, capacityItems: number): number {
  if (!spec.negativePopulated || !spec.absent) return 0;
  return cacheHitRatio({
    rate,
    popularity: spec.absent,
    capacityItems,
    ttlSec: spec.negativeTtlSec,
  });
}

function propagate(
  operations: readonly OperationModel[],
  state: OutcomeState,
  callFor: (step: CallPathStep) => CallModel,
  ingress: IngressModel,
  shed: ReadonlyMap<string, number>,
): Propagation {
  const loads = new Map<string, Load>();
  const retries = new Map<string, number>();
  const lookups = new Map<string, { existing: number; absent: number }>();
  const traffic = new Map<string, number>();
  const tallies = new Map<string, CallTally>();
  const addLoad = (id: string, rate: number, write: boolean) => {
    const load = loads.get(id) ?? { read: 0, write: 0 };
    loads.set(
      id,
      write ? { ...load, write: load.write + rate } : { ...load, read: load.read + rate },
    );
  };
  const addTraffic = (id: string | null, rate: number) => {
    if (id !== null) traffic.set(id, (traffic.get(id) ?? 0) + rate);
  };
  const tally = (id: string | null, add: CallTally) => {
    if (id === null) return;
    const t = tallies.get(id) ?? { calls: 0, attempts: 0, failed: 0, shortCircuited: 0 };
    tallies.set(id, {
      calls: t.calls + add.calls,
      attempts: t.attempts + add.attempts,
      failed: t.failed + add.failed,
      shortCircuited: t.shortCircuited + add.shortCircuited,
    });
  };

  for (const op of operations) {
    const isWrite = op.operation.class === "write";
    let arriving = op.rate;
    const route = op.analysis.ingress;
    route?.connections.forEach((connectionId, index) => {
      const hop = route.components[index + 1];
      addTraffic(connectionId, arriving);
      if (hop && op.ingress.includes(hop)) {
        const lost = ingress.lost(hop, isWrite);
        // Requests routed to a failed node do no work there.
        addLoad(hop, arriving * (1 - lost), isWrite);
        arriving *= (1 - ingress.overload(hop)) * (1 - lost);
      }
    });
    for (const cls of op.classes) {
      for (const path of op.analysis.paths) {
        const weight = arriving * cls.share * pathProbability(path, cls, state);
        if (weight === 0) continue;
        for (const step of path.steps) {
          if (step.kind !== "call") continue;
          const call = callFor(step);
          const failed = step.outcome === "error";
          const perCall = failed ? call.attemptsOnFailure : call.attemptsOnSuccess;
          const callRate = weight * callShare(step);
          const attempts = callRate * perCall;
          const write = ACTIONS[step.action].effect !== "read";
          addLoad(step.target, attempts * call.reach, write);
          retries.set(
            step.target,
            (retries.get(step.target) ?? 0) + callRate * Math.max(0, perCall - 1) * call.reach,
          );
          addTraffic(step.connectionId, attempts * (1 - (shed.get(step.connectionId ?? "") ?? 0)));
          tally(step.connectionId, {
            calls: callRate,
            attempts,
            failed: failed ? callRate : 0,
            shortCircuited:
              failed && call.failure > 0 ? (callRate * call.shortCircuit) / call.failure : 0,
          });
          if (step.action === "cache.get") {
            const key = cacheKey(step.target, step.entity);
            const entry = lookups.get(key) ?? { existing: 0, absent: 0 };
            lookups.set(
              key,
              cls.exists
                ? { ...entry, existing: entry.existing + weight }
                : { ...entry, absent: entry.absent + weight },
            );
          }
        }
      }
    }
  }
  return { loads, retries, lookups, traffic, calls: tallies };
}
