import {
  ACTIONS,
  type Connection,
  DEFAULT_POLICY,
  type Environment,
  type Workload,
} from "@archdrill/model";
import type { CallPathStep } from "../paths/types";
import { cacheHitRatio } from "./cache-model";
import { bulkheadShed, type CallModel, callModel } from "./calls";
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
  utilizationOf,
} from "./summary";
import type { EnvironmentMetrics, MetastableComponent } from "./types";

export { NETWORK_RTT_MS } from "./calls";
export { CACHE_FILL_FACTOR, type SimulationContext } from "./setup";
export { OVERLOAD_WAIT_MS } from "./summary";

const MAX_ITERATIONS = 200;
const TOLERANCE = 1e-7;

/** Damping per iteration: strong feedback (breakers, overload) needs smaller steps if it has not settled. */
function dampingAt(iteration: number): number {
  if (iteration <= 40) return 0.5;
  return iteration <= 120 ? 0.25 : 0.1;
}

/** Quantities the fixed point iterates on, each relaxed with damping. */
interface LoopState {
  /** Per component: share of arrivals rejected by overload. */
  readonly drop: Map<string, number>;
  /** Per connection: share of served attempts that exceed the caller's timeout. */
  readonly timedOut: Map<string, number>;
  /** Per connection with a bulkhead: calls per second that flow steps make (first attempts). */
  readonly callRates: Map<string, number>;
  readonly hit: Map<string, number>;
  readonly negativeHit: Map<string, number>;
}

/** Iterations that warm the caches before the fixed point starts. */
const WARM_UP_ITERATIONS = 40;

interface Model {
  readonly loop: LoopState;
  readonly calls: ReturnType<typeof callModels>;
  readonly state: OutcomeState;
  readonly ingress: IngressModel;
}

interface Fixtures {
  readonly profiles: ReadonlyMap<string, ComponentProfile>;
  readonly operations: readonly OperationModel[];
  readonly caches: readonly CacheSpec[];
  readonly connections: readonly Connection[];
  readonly faults: ReadonlyMap<string, ComponentFault>;
  readonly occupancy: ReadonlyMap<string, { all: number; aliases: number }>;
}

function createModel(fixtures: Fixtures): Model {
  const loop: LoopState = {
    drop: new Map(),
    timedOut: new Map(),
    callRates: new Map(),
    hit: new Map(),
    negativeHit: new Map(),
  };
  const calls = callModels(fixtures.connections, fixtures.faults, loop);
  const state: OutcomeState = {
    callFailure: (step) => calls.get(step).failure,
    occupancy: (entity) => fixtures.occupancy.get(entity ?? "")?.all ?? 0,
    aliasOccupancy: (entity) => fixtures.occupancy.get(entity ?? "")?.aliases ?? 0,
    hitRatio: (id, entity) => loop.hit.get(cacheKey(id, entity)) ?? 0,
    negativeHitRatio: (id, entity) => loop.negativeHit.get(cacheKey(id, entity)) ?? 0,
  };
  return { loop, calls, state, ingress: ingressModel(fixtures.faults, loop) };
}

function propagateModel(model: Model, fixtures: Fixtures): Propagation {
  model.calls.reset();
  return propagate(
    fixtures.operations,
    model.state,
    model.calls.get,
    model.ingress,
    model.calls.shedOf,
  );
}

/**
 * Fills the caches at nominal load before anything can fail. Starting the
 * fixed point from cold caches would be a shock of its own: every request
 * misses at once, which can tip designs with aggressive retries into an
 * overloaded state they never leave.
 */
function warmCaches(model: Model, fixtures: Fixtures): void {
  for (let i = 0; i < WARM_UP_ITERATIONS; i++) {
    relaxCaches(fixtures.caches, propagateModel(model, fixtures), model.loop, 0.5);
  }
}

function solve(model: Model, fixtures: Fixtures): { converged: boolean; iterations: number } {
  let iterations = 0;
  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const flow = propagateModel(model, fixtures);
    const damping = dampingAt(iterations);
    const delta = Math.max(
      relaxComponents(fixtures.profiles, flow, model.loop, damping),
      relaxConnections(fixtures.connections, fixtures.profiles, flow, model.loop, damping),
      relaxCaches(fixtures.caches, flow, model.loop, damping),
    );
    if (delta < TOLERANCE) return { converged: true, iterations };
  }
  return { converged: false, iterations };
}

/**
 * Retries can give a design a second, overloaded steady state that it only
 * reaches after a shock and then cannot leave (a metastable failure). Solving
 * again from cold caches, a shock every design meets after a deploy or a
 * cache flush, finds components that stay overloaded there but not in the
 * healthy state.
 */
function shockTest(fixtures: Fixtures, healthy: Propagation): MetastableComponent[] {
  if (!fixtures.connections.some((c) => c.policy.retries > 0)) return [];
  const shocked = createModel(fixtures);
  solve(shocked, fixtures);
  const flow = propagateModel(shocked, fixtures);
  const result: MetastableComponent[] = [];
  for (const [id, profile] of fixtures.profiles) {
    const load = flow.loads.get(id);
    const utilization = utilizationOf(load, profile);
    if (utilization <= 1 || utilizationOf(healthy.loads.get(id), profile) > 1) continue;
    result.push({
      componentId: id,
      utilization,
      load: (load?.read ?? 0) + (load?.write ?? 0),
      retryLoad: flow.retries.get(id) ?? 0,
    });
  }
  return result;
}

/**
 * Steady-state model of one environment: load propagation over path
 * probabilities, cache hit ratios, queueing latency, overload, faults, and the
 * callers' timeouts, retries, circuit breakers and bulkheads. These feed back
 * on each other (a failing call takes the error branch and may be retried,
 * which shifts load), so the model iterates to a damped fixed point, starting
 * from warm caches. If it does not settle, the metrics are the last iterate
 * and `converged` is false.
 */
export function simulateEnvironment(
  workload: Workload,
  environment: Environment,
  ctx: SimulationContext,
): EnvironmentMetrics {
  const faults = resolveFaults(environment.faults, ctx.attempt, ctx.catalog);
  const profiles = buildProfiles(ctx, faults);
  const fixtures: Fixtures = {
    profiles,
    operations: buildOperations(workload, environment, ctx),
    caches: buildCacheSpecs(workload, profiles, ctx),
    connections: ctx.attempt.architecture.connections,
    faults,
    occupancy: occupancies(workload, ctx),
  };
  const model = createModel(fixtures);
  warmCaches(model, fixtures);
  const { converged, iterations } = solve(model, fixtures);

  const final = propagateModel(model, fixtures);
  const components = summarizeComponents(
    profiles,
    final,
    model.loop.drop,
    storedGb(workload, ctx),
    faults,
  );
  const connections = fixtures.connections;
  return {
    environment,
    operations: summarizeOperations(fixtures.operations, model.state, model.ingress.pass, {
      components,
      callFor: model.calls.get,
      replicaAck: replicaAckMs(workload, ctx),
      timeoutOf: (step) => connections.find((c) => c.id === step.connectionId)?.policy.timeoutMs,
    }),
    components,
    caches: fixtures.caches.map((spec) => summarizeCache(spec, final, model.state)),
    connections: final.traffic,
    calls: summarizeCalls(final, model.calls.shedOf, model.loop.timedOut),
    monthlyCost: [...components.values()].reduce((sum, c) => sum + c.monthlyCost, 0),
    converged,
    iterations,
    metastable: shockTest(fixtures, final),
  };
}

function relax(values: Map<string, number>, key: string, target: number, damping: number): number {
  const current = values.get(key) ?? 0;
  const next = current + damping * (target - current);
  values.set(key, next);
  return Math.abs(next - current);
}

function relaxComponents(
  profiles: ReadonlyMap<string, ComponentProfile>,
  flow: Propagation,
  loop: LoopState,
  damping: number,
): number {
  let delta = 0;
  for (const [id, profile] of profiles) {
    const target = dropFor(flow.loads.get(id), profile);
    delta = Math.max(delta, relax(loop.drop, id, target, damping));
  }
  return delta;
}

/** Timeouts follow the target's latency; bulkheads follow the call rate. */
function relaxConnections(
  connections: readonly Connection[],
  profiles: ReadonlyMap<string, ComponentProfile>,
  flow: Propagation,
  loop: LoopState,
  damping: number,
): number {
  let delta = 0;
  for (const connection of connections) {
    const { timeoutMs, maxRps } = connection.policy;
    const profile = profiles.get(connection.to);
    if (timeoutMs !== undefined && profile) {
      const latency = componentLatency(flow.loads.get(connection.to), profile);
      delta = Math.max(
        delta,
        relax(loop.timedOut, connection.id, timeoutShare(latency, timeoutMs), damping),
      );
    }
    if (maxRps !== undefined) {
      const rate = flow.calls.get(connection.id)?.calls ?? 0;
      // Relative change, so the tolerance means the same for any traffic level.
      const before = loop.callRates.get(connection.id) ?? 0;
      relax(loop.callRates, connection.id, rate, damping);
      const after = loop.callRates.get(connection.id) ?? 0;
      delta = Math.max(delta, Math.abs(after - before) / Math.max(1, rate));
    }
  }
  return delta;
}

function relaxCaches(
  caches: readonly CacheSpec[],
  flow: Propagation,
  loop: LoopState,
  damping: number,
): number {
  let delta = 0;
  for (const spec of caches) {
    const key = cacheKey(spec.componentId, spec.entity);
    const lookups = flow.lookups.get(key) ?? { existing: 0, absent: 0 };
    const [positiveItems, negativeItems] = splitCapacity(spec, lookups);
    const positive = hitFor(spec, lookups.existing, positiveItems);
    const negative = negativeHitFor(spec, lookups.absent, negativeItems);
    delta = Math.max(delta, relax(loop.hit, key, positive, damping));
    delta = Math.max(delta, relax(loop.negativeHit, key, negative, damping));
  }
  return delta;
}

/**
 * Call models per (connection, reads or writes), rebuilt once per iteration
 * from the current overload and timeout shares. A bulkhead limits the whole
 * connection; its shedding share is computed once per iteration, from the
 * risks of the first kind of call that asks.
 */
function callModels(
  connections: readonly Connection[],
  faults: ReadonlyMap<string, ComponentFault>,
  loop: LoopState,
) {
  const policies = new Map(connections.map((c) => [c.id, c.policy]));
  const memo = new Map<string, CallModel>();
  const shedding = new Map<string, number>();
  const get = (step: CallPathStep): CallModel => {
    const write = ACTIONS[step.action].effect !== "read";
    const connection = step.connectionId ?? `-${step.target}`;
    const key = `${connection}|${write ? "w" : "r"}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const fault = faults.get(step.target) ?? NO_FAULT;
    const policy = policies.get(connection) ?? DEFAULT_POLICY;
    const risks = {
      fault: write ? fault.failWrite : fault.failRead,
      faultHangs: fault.hang,
      overload: loop.drop.get(step.target) ?? 0,
      timeout: loop.timedOut.get(connection) ?? 0,
    };
    const shed =
      shedding.get(connection) ?? bulkheadShed(risks, policy, loop.callRates.get(connection) ?? 0);
    shedding.set(connection, shed);
    const model = callModel({ ...risks, shed }, policy);
    memo.set(key, model);
    return model;
  };
  const shedOf = (connectionId: string | null) =>
    connectionId === null ? 0 : (shedding.get(connectionId) ?? 0);
  const reset = () => {
    memo.clear();
    shedding.clear();
  };
  return { get, shedOf, reset };
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
  shedOf: (connectionId: string | null) => number,
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
          addTraffic(step.connectionId, attempts * (1 - shedOf(step.connectionId)));
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
