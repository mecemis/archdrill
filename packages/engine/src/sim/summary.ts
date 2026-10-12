import { ACTIONS } from "@archdrill/model";
import type { CallPathStep, Path } from "../paths/types";
import type { CallModel } from "./calls";
import { NETWORK_RTT_MS } from "./calls";
import { type ComponentProfile, HOURS_PER_MONTH, SECONDS_PER_MONTH } from "./capacity";
import type { ComponentFault } from "./faults";
import { type Moments, mixtureQuantile, momentGammaCdf, type WeightedMoments } from "./math/gamma";
import { queueWait } from "./math/queueing";
import { callShare, type OutcomeState, outcomeProbability } from "./outcomes";
import type { CacheSpec, OperationModel } from "./setup";
import { cacheKey } from "./setup";
import type {
  CacheMetrics,
  ComponentMetrics,
  ConnectionCallMetrics,
  LatencySummary,
  OperationMetrics,
  PathMetrics,
} from "./types";

/**
 * Extra wait for requests that an overloaded component does serve: its queue
 * keeps growing until callers give up. Callers with a timeout give up sooner;
 * this is the documented wait for those without one.
 */
export const OVERLOAD_WAIT_MS = 1000;

export type Load = { readonly read: number; readonly write: number };

/** What load propagation found in one pass. */
export interface Propagation {
  /** Requests per second reaching each component, retries included. */
  readonly loads: ReadonlyMap<string, Load>;
  /** Retries per second reaching each component. */
  readonly retries: ReadonlyMap<string, number>;
  readonly lookups: ReadonlyMap<string, { existing: number; absent: number }>;
  /** Requests per second crossing each connection, retries included. */
  readonly traffic: ReadonlyMap<string, number>;
  /** Per connection that flow steps call over: calls, attempts and failures per second. */
  readonly calls: ReadonlyMap<string, CallTally>;
}

export interface CallTally {
  readonly calls: number;
  readonly attempts: number;
  readonly failed: number;
  readonly shortCircuited: number;
}

export function utilizationOf(load: Load | undefined, profile: ComponentProfile): number {
  if (!load) return 0;
  const read = Number.isFinite(profile.readCapacity) ? load.read / profile.readCapacity : 0;
  const write = Number.isFinite(profile.writeCapacity) ? load.write / profile.writeCapacity : 0;
  return read + write;
}

/** Beyond capacity, the excess share of arrivals is rejected. */
export function dropFor(load: Load | undefined, profile: ComponentProfile): number {
  const rho = utilizationOf(load, profile);
  return rho > 1 ? 1 - 1 / rho : 0;
}

/** Latency a component adds per visit: service plus queueing (excluding the network). */
export function componentLatency(load: Load | undefined, profile: ComponentProfile): Moments {
  const utilization = utilizationOf(load, profile);
  const wait =
    utilization > 1
      ? OVERLOAD_WAIT_MS
      : queueWait(utilization, profile.servers, profile.serviceTimeMs);
  const service = profile.serviceTimeMs;
  return { mean: service + wait, variance: (profile.cv * service) ** 2 + wait ** 2 };
}

/** Share of served attempts that come back after the caller's timeout. */
export function timeoutShare(latency: Moments, timeoutMs: number): number {
  return 1 - momentGammaCdf(Math.max(0, timeoutMs - NETWORK_RTT_MS), latency);
}

export function summarizeComponents(
  profiles: ReadonlyMap<string, ComponentProfile>,
  flow: Propagation,
  drop: ReadonlyMap<string, number>,
  stored: ReadonlyMap<string, number>,
  faults: ReadonlyMap<string, ComponentFault>,
): Map<string, ComponentMetrics> {
  const metrics = new Map<string, ComponentMetrics>();
  for (const [id, profile] of profiles) {
    const load = flow.loads.get(id) ?? { read: 0, write: 0 };
    const requestCost = profile.requestCost
      ? ((load.read * profile.requestCost.readPerMillion +
          load.write * profile.requestCost.writePerMillion) *
          SECONDS_PER_MONTH) /
        1e6
      : 0;
    const storageGb = (stored.get(id) ?? 0) * profile.storageCopies;
    const instanceCost = profile.costPerHour * HOURS_PER_MONTH;
    const storageCost = storageGb * profile.storagePricePerGbMonth;
    metrics.set(id, {
      componentId: id,
      readLoad: load.read,
      writeLoad: load.write,
      readCapacity: profile.readCapacity,
      writeCapacity: profile.writeCapacity,
      utilization: utilizationOf(load, profile),
      dropRate: drop.get(id) ?? 0,
      retryLoad: flow.retries.get(id) ?? 0,
      faults: faults.get(id)?.labels ?? [],
      latency: componentLatency(load, profile),
      storageGb,
      monthlyCost: instanceCost + requestCost + storageCost,
      costBreakdown: { instances: instanceCost, requests: requestCost, storage: storageCost },
    });
  }
  return metrics;
}

export function summarizeCalls(
  flow: Propagation,
  shed: ReadonlyMap<string, number>,
  timedOut: ReadonlyMap<string, number>,
): Map<string, ConnectionCallMetrics> {
  const result = new Map<string, ConnectionCallMetrics>();
  for (const [connectionId, tally] of flow.calls) {
    const share = (value: number) => (tally.calls > 0 ? value / tally.calls : 0);
    result.set(connectionId, {
      connectionId,
      calls: tally.calls,
      attempts: tally.attempts,
      failure: share(tally.failed),
      shortCircuit: share(tally.shortCircuited),
      shed: shed.get(connectionId) ?? 0,
      timedOut: timedOut.get(connectionId) ?? 0,
    });
  }
  return result;
}

export function addMoments(a: Moments, b: Moments): Moments {
  return { mean: a.mean + b.mean, variance: a.variance + b.variance };
}

/**
 * Moments of a cost paid with probability `share` and nothing otherwise (a
 * Bernoulli mixture). The moments are exact; the Gamma fitted to them is
 * unimodal, so percentiles of a rare, expensive call are approximate.
 */
function mixMoments(m: Moments, share: number): Moments {
  if (share === 1) return m;
  return {
    mean: share * m.mean,
    variance: share * m.variance + share * (1 - share) * m.mean ** 2,
  };
}

export const NETWORK_HOP: Moments = {
  mean: NETWORK_RTT_MS,
  variance: (0.2 * NETWORK_RTT_MS) ** 2,
};

/** Everything path latency depends on. */
export interface LatencyInputs {
  readonly components: ReadonlyMap<string, ComponentMetrics>;
  readonly callFor: (step: CallPathStep) => CallModel;
  /** Milliseconds writes to a component wait for its replicas. */
  readonly replicaAck: ReadonlyMap<string, number>;
}

function callLatency(step: CallPathStep, inputs: LatencyInputs): Moments {
  const call = inputs.callFor(step);
  if (step.outcome === "error") return call.failureLatency;
  const service = inputs.components.get(step.target)?.latency;
  let total = addMoments(
    service ? addMoments(NETWORK_HOP, service) : NETWORK_HOP,
    call.successExtra,
  );
  const ack = inputs.replicaAck.get(step.target) ?? 0;
  if (ack > 0 && ACTIONS[step.action].effect !== "read") {
    total = addMoments(total, { mean: ack, variance: (0.2 * ack) ** 2 });
  }
  return total;
}

function pathLatency(path: Path, ingressLatency: Moments, inputs: LatencyInputs): Moments {
  let total = ingressLatency;
  for (const step of path.steps) {
    if (step.kind !== "call") continue;
    // Batched allocation: only one request in a batch pays for the call.
    total = addMoments(total, mixMoments(callLatency(step, inputs), callShare(step)));
  }
  return total;
}

export function summarize(components: readonly WeightedMoments[]): LatencySummary {
  const total = components.reduce((sum, c) => sum + c.weight, 0);
  return {
    mean: total > 0 ? components.reduce((sum, c) => sum + c.weight * c.mean, 0) / total : 0,
    p50: mixtureQuantile(components, 0.5),
    p95: mixtureQuantile(components, 0.95),
    p99: mixtureQuantile(components, 0.99),
  };
}

export function pathProbability(
  path: Path,
  cls: OperationModel["classes"][number],
  state: OutcomeState,
): number {
  let probability = 1;
  path.steps.forEach((step, index) => {
    if (probability === 0) return;
    probability *= outcomeProbability(step, cls, state, path.steps.slice(0, index));
  });
  return probability;
}

export function summarizeOperations(
  operations: readonly OperationModel[],
  state: OutcomeState,
  ingressPass: (op: OperationModel) => number,
  inputs: LatencyInputs,
): Map<string, OperationMetrics> {
  const result = new Map<string, OperationMetrics>();
  for (const op of operations) {
    const hops = op.analysis.ingress?.connections.length ?? 0;
    let ingressLatency: Moments = {
      mean: hops * NETWORK_HOP.mean,
      variance: hops * NETWORK_HOP.variance,
    };
    for (const id of op.ingress) {
      const latency = inputs.components.get(id)?.latency;
      if (latency) ingressLatency = addMoments(ingressLatency, latency);
    }
    const pass = ingressPass(op);
    const paths: PathMetrics[] = [];
    const mixture: WeightedMoments[] = [];
    let success = 0;
    let unhandled = 0;
    let errorStatus = 0;
    for (const path of op.analysis.paths) {
      const probability = op.classes.reduce(
        (sum, cls) => sum + cls.share * pathProbability(path, cls, state),
        0,
      );
      const moments = pathLatency(path, ingressLatency, inputs);
      const status = path.terminal.kind === "respond" ? path.terminal.status : null;
      const succeeded = status !== null && op.operation.successStatuses.includes(status);
      if (status === null) unhandled += probability;
      else if (succeeded) success += probability;
      else errorStatus += probability;
      paths.push({ pathId: path.id, probability, latency: summarize([{ weight: 1, ...moments }]) });
      // Latency is measured on successful requests: fast failures would otherwise pull the tail down.
      if (succeeded) mixture.push({ weight: pass * probability, ...moments });
    }
    result.set(op.operation.id, {
      operation: op.operation.id,
      rate: op.rate,
      successRate: pass * success,
      ingressRejectRate: 1 - pass,
      failures: {
        rejected: 1 - pass,
        unhandled: pass * unhandled,
        errorStatus: pass * errorStatus,
      },
      latency: summarize(mixture),
      paths,
    });
  }
  return result;
}

export function summarizeCache(
  spec: CacheSpec,
  flow: Propagation,
  state: OutcomeState,
): CacheMetrics {
  return {
    componentId: spec.componentId,
    entity: spec.entity,
    hitRatio: state.hitRatio(spec.componentId, spec.entity),
    negativeHitRatio: state.negativeHitRatio(spec.componentId, spec.entity),
    capacityItems: spec.capacityItems,
    ttlSec: spec.ttlSec,
    populated: spec.populated,
    lookupRate: flow.lookups.get(cacheKey(spec.componentId, spec.entity))?.existing ?? 0,
  };
}
