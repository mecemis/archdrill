import { ACTIONS, type RequestClass } from "@archdrill/model";
import type { CallPathStep, Path, PathStep } from "../paths/types";

const NO_STEPS: readonly PathStep[] = [];

import type { CallModel } from "./calls";
import { NETWORK_RTT_MS } from "./calls";
import { type ComponentProfile, HOURS_PER_MONTH, SECONDS_PER_MONTH } from "./capacity";
import type { ComponentFault } from "./faults";
import {
  type Moments,
  mixtureQuantile,
  momentGammaCdf,
  truncatedMoments,
  type WeightedMoments,
} from "./math/gamma";
import { queueWait } from "./math/queueing";
import { callShare, collectsBatch, type OutcomeState, outcomeProbability } from "./outcomes";
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
  /** The part of those loads that asks for the hot key. */
  readonly hotLoads: ReadonlyMap<string, Load>;
  /** Retries per second reaching each component. */
  readonly retries: ReadonlyMap<string, number>;
  readonly lookups: ReadonlyMap<string, { existing: number; absent: number; hot: number }>;
  /** Per entity: requests for existing keys that looked it up in any cache, and how many any tier answered. */
  readonly entityLookups: ReadonlyMap<string, { lookups: number; hits: number }>;
  /** Requests per second crossing each connection, retries included. */
  readonly traffic: ReadonlyMap<string, number>;
  /** Per connection that flow steps call over: calls, attempts and failures per second. */
  readonly calls: ReadonlyMap<string, CallTally>;
  /** Per operation: its rate and classes (derived for consumers) and redeliveries per second. */
  readonly operations: ReadonlyMap<string, ResolvedOperation>;
  /** Items per second reaching each step that collects a batch, keyed by `batchKey`. */
  readonly batchArrivals: ReadonlyMap<string, number>;
}

export interface ResolvedOperation {
  readonly rate: number;
  readonly classes: readonly RequestClass[];
  readonly redeliveries: number;
}

export function batchKey(operation: string, stepId: string): string {
  return `${operation}|${stepId}`;
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
function latencyAt(utilization: number, profile: ComponentProfile): Moments {
  const wait = overloadAwareWait(utilization, profile);
  const service = profile.serviceTimeMs;
  return { mean: service + wait, variance: (profile.cv * service) ** 2 + wait ** 2 };
}

const total = (load: Load | undefined) => (load ? load.read + load.write : 0);

/**
 * Utilisation of an ordinary shard and of the shard that holds the hot key.
 * Ordinary keys spread evenly; the hot key's whole load lands on one shard,
 * which has a 1/shards share of the capacity. Components that are not
 * sharded balance every request, so a hot key changes nothing there.
 */
export function shardUtilizations(
  load: Load | undefined,
  hotLoad: Load | undefined,
  profile: ComponentProfile,
): { readonly normal: number; readonly hottest: number } {
  const all = utilizationOf(load, profile);
  if (!profile.sharded || total(hotLoad) <= 0) return { normal: all, hottest: all };
  const hot = utilizationOf(hotLoad, profile);
  const normal = all - hot;
  return { normal, hottest: profile.shards * hot + normal };
}

/** Share of arrivals rejected at a utilisation. */
export function dropAt(utilization: number): number {
  return utilization > 1 ? 1 - 1 / utilization : 0;
}

/**
 * Latency a component adds per visit: service plus queueing (excluding the
 * network). With a hot key, calls served by its shard queue at that shard's
 * utilisation, the others at an ordinary shard's.
 */
export function componentLatency(
  load: Load | undefined,
  profile: ComponentProfile,
  hotLoad?: Load,
): Moments {
  const { normal, hottest } = shardUtilizations(load, hotLoad, profile);
  if (hottest === normal) return latencyAt(normal, profile);
  const calls = total(load);
  const hot = total(hotLoad);
  const onHotShard = calls > 0 ? (hot + (calls - hot) / profile.shards) / calls : 0;
  const a = latencyAt(hottest, profile);
  const b = latencyAt(normal, profile);
  const mean = onHotShard * a.mean + (1 - onHotShard) * b.mean;
  const second =
    onHotShard * (a.variance + a.mean ** 2) + (1 - onHotShard) * (b.variance + b.mean ** 2);
  return { mean, variance: Math.max(0, second - mean ** 2) };
}

/**
 * Utilisation band over which the queueing wait ramps up to the overload
 * wait. A jump at exactly 1 would make timeouts, and with them circuit
 * breakers, flip back and forth between iterations.
 */
const SATURATION_START = 0.98;
const SATURATION_END = 1.02;

function overloadAwareWait(utilization: number, profile: ComponentProfile): number {
  if (utilization <= SATURATION_START) {
    return queueWait(utilization, profile.servers, profile.serviceTimeMs);
  }
  if (utilization >= SATURATION_END) return OVERLOAD_WAIT_MS;
  const near = queueWait(SATURATION_START, profile.servers, profile.serviceTimeMs);
  const t = (utilization - SATURATION_START) / (SATURATION_END - SATURATION_START);
  return near + t * (OVERLOAD_WAIT_MS - near);
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
    const hotLoad = flow.hotLoads.get(id);
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
      hottestShardUtilization: shardUtilizations(load, hotLoad, profile).hottest,
      instances: profile.instances,
      dropRate: drop.get(id) ?? 0,
      retryLoad: flow.retries.get(id) ?? 0,
      faults: faults.get(id)?.labels ?? [],
      latency: componentLatency(load, profile, hotLoad),
      hotLatency: latencyAt(shardUtilizations(load, hotLoad, profile).hottest, profile),
      storageGb,
      monthlyCost: instanceCost + requestCost + storageCost,
      costBreakdown: { instances: instanceCost, requests: requestCost, storage: storageCost },
    });
  }
  return metrics;
}

export function summarizeCalls(
  flow: Propagation,
  shedOf: (connectionId: string) => number,
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
      shed: shedOf(connectionId),
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
  readonly callFor: (step: CallPathStep, hotKey: boolean) => CallModel;
  /** Components that run inside their caller, reached without a network hop. */
  readonly inProcess: ReadonlySet<string>;
  /** Milliseconds writes to a component wait for its replicas. */
  readonly replicaAck: ReadonlyMap<string, number>;
  /** The caller's timeout for a call, if it set one. */
  readonly timeoutOf: (step: CallPathStep) => number | undefined;
  /** Items per second reaching each step that collects a batch, keyed by `batchKey`. */
  readonly batchArrivals: ReadonlyMap<string, number>;
}

/** A batch that is not full is sent anyway after this long. */
export const BATCH_WINDOW_MS = 5000;

/**
 * Time an item waits for its batch to fill: uniform between zero and the
 * time the batch takes to fill (or the batch window, if that is shorter).
 * Every instance of the handler fills its own batches.
 */
function batchWait(
  step: CallPathStep,
  path: Path,
  inputs: LatencyInputs,
  batchers: number,
): Moments {
  const total = inputs.batchArrivals.get(batchKey(path.operation, step.stepId)) ?? 0;
  const arrivals = total / Math.max(1, batchers);
  const size = step.batchSize ?? 1;
  if (arrivals <= 0 || size <= 1) return { mean: 0, variance: 0 };
  const fill = Math.min(BATCH_WINDOW_MS, ((size - 1) / arrivals) * 1000);
  return { mean: fill / 2, variance: fill ** 2 / 12 };
}

function callLatency(step: CallPathStep, inputs: LatencyInputs, hotKey: boolean): Moments {
  const call = inputs.callFor(step, hotKey);
  if (step.outcome === "error") return call.failureLatency;
  const hop = inputs.inProcess.has(step.target) ? { mean: 0, variance: 0 } : NETWORK_HOP;
  const timeout = inputs.timeoutOf(step);
  const component = inputs.components.get(step.target);
  // Requests for the hot key queue at the shard that holds it.
  const measured = hotKey ? component?.hotLatency : component?.latency;
  // A call that succeeded came back before the caller's timeout.
  const service =
    measured && timeout !== undefined
      ? truncatedMoments(measured, Math.max(0, timeout - NETWORK_RTT_MS))
      : measured;
  let total = addMoments(service ? addMoments(hop, service) : hop, call.successExtra);
  const ack = inputs.replicaAck.get(step.target) ?? 0;
  if (ack > 0 && ACTIONS[step.action].effect !== "read") {
    total = addMoments(total, { mean: ack, variance: (0.2 * ack) ** 2 });
  }
  return total;
}

function pathLatency(
  path: Path,
  ingressLatency: Moments,
  inputs: LatencyInputs,
  hotKey: boolean,
  batchers: number,
): Moments {
  let total = ingressLatency;
  for (const step of path.steps) {
    if (step.kind !== "call") continue;
    const latency = callLatency(step, inputs, hotKey);
    if (collectsBatch(step)) {
      // Every item waits for its batch, then for the call that carries it.
      total = addMoments(total, addMoments(batchWait(step, path, inputs, batchers), latency));
    } else {
      // Batched allocation: only one request in a batch pays for the call.
      total = addMoments(total, mixMoments(latency, callShare(step)));
    }
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
  const steps = path.steps;
  for (let index = 0; index < steps.length && probability > 0; index++) {
    const step = steps[index] as PathStep;
    // Only a conditional insert looks back along the path (where its key came from).
    const prior =
      step.kind === "call" && step.action === "store.insertIfAbsent"
        ? steps.slice(0, index)
        : NO_STEPS;
    probability *= outcomeProbability(step, cls, state, prior);
  }
  return probability;
}

export function summarizeOperations(
  operations: readonly OperationModel[],
  resolved: ReadonlyMap<string, ResolvedOperation>,
  state: OutcomeState,
  ingressPass: (op: OperationModel) => number,
  inputs: LatencyInputs,
): Map<string, OperationMetrics> {
  const result = new Map<string, OperationMetrics>();
  for (const op of operations) {
    const { rate, classes, redeliveries } = resolved.get(op.operation.id) ?? {
      rate: op.rate,
      classes: op.classes,
      redeliveries: 0,
    };
    const trigger = op.operation.trigger.type;
    const batchers = inputs.components.get(op.analysis.flow?.handler ?? "")?.instances ?? 1;
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
      const byClass = classes.map((cls) => ({
        hot: cls.hotKey,
        p: cls.share * pathProbability(path, cls, state),
      }));
      const probability = byClass.reduce((sum, c) => sum + c.p, 0);
      const hotProbability = byClass.reduce((sum, c) => sum + (c.hot ? c.p : 0), 0);
      const moments = pathLatency(path, ingressLatency, inputs, false, batchers);
      const status = path.terminal.kind === "respond" ? path.terminal.status : null;
      const succeeded = status !== null && op.operation.successStatuses.includes(status);
      if (status === null) unhandled += probability;
      else if (succeeded) success += probability;
      else errorStatus += probability;
      paths.push({ pathId: path.id, probability, latency: summarize([{ weight: 1, ...moments }]) });
      // Latency is measured on successful requests: fast failures would otherwise pull the tail down.
      if (succeeded) {
        mixture.push({ weight: pass * (probability - hotProbability), ...moments });
        if (hotProbability > 0) {
          const hot = pathLatency(path, ingressLatency, inputs, true, batchers);
          mixture.push({ weight: pass * hotProbability, ...hot });
        }
      }
    }
    result.set(op.operation.id, {
      operation: op.operation.id,
      trigger,
      rate,
      // Work that waits in a queue or a job's backlog is late, not lost.
      backlogGrowth: trigger === "request" ? 0 : rate * (1 - pass),
      redeliveries,
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
  const lookups = flow.lookups.get(cacheKey(spec.componentId, spec.entity));
  const ordinary = lookups?.existing ?? 0;
  const hot = lookups?.hot ?? 0;
  const ordinaryHit = state.hitRatio(spec.componentId, spec.entity, false);
  const hotHit = state.hitRatio(spec.componentId, spec.entity, true);
  return {
    componentId: spec.componentId,
    entity: spec.entity,
    // Over every lookup for a key that exists, the hot key's included.
    hitRatio:
      ordinary + hot > 0 ? (ordinary * ordinaryHit + hot * hotHit) / (ordinary + hot) : ordinaryHit,
    negativeHitRatio: state.negativeHitRatio(spec.componentId, spec.entity),
    capacityItems: spec.capacityItems,
    ttlSec: spec.ttlSec,
    populated: spec.populated,
    lookupRate: ordinary + hot,
  };
}
