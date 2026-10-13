import type { Component, Connection, Environment, Workload } from "@archdrill/model";
import { relaxCaches } from "./cache-loop";
import type { ComponentProfile } from "./capacity";
import { type ComponentFault, resolveFaults } from "./faults";
import type { OutcomeState } from "./outcomes";
import {
  type CallModels,
  callModels,
  emptyLoopState,
  type IngressModel,
  ingressModel,
  type LoopState,
  propagate,
} from "./propagate";
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
  componentLatency,
  dropAt,
  type Propagation,
  shardUtilizations,
  summarizeCache,
  summarizeCalls,
  summarizeComponents,
  summarizeOperations,
  timeoutShare,
  utilizationOf,
} from "./summary";
import type { EnvironmentMetrics, MetastableComponent } from "./types";

export { NETWORK_RTT_MS } from "./calls";
export { MAX_DELIVERIES } from "./propagate";
export { CACHE_FILL_FACTOR, type SimulationContext } from "./setup";
export { OVERLOAD_WAIT_MS } from "./summary";

const MAX_ITERATIONS = 200;
const TOLERANCE = 1e-7;
/** Iterations that warm the caches before the fixed point starts, at most. */
const WARM_UP_ITERATIONS = 40;
/** Warm enough: the fixed point finishes relaxing the caches anyway. */
const WARM_UP_TOLERANCE = 1e-4;
/**
 * Below this utilisation at a cold start, nothing is close enough to
 * capacity for retries to tip it over, so the shock test can be skipped.
 */
const SHOCK_UTILIZATION = 0.8;

/** Damping per iteration: strong feedback (breakers, overload) needs smaller steps if it has not settled. */
function dampingAt(iteration: number): number {
  if (iteration <= 40) return 0.5;
  return iteration <= 120 ? 0.25 : 0.1;
}

interface Model {
  readonly loop: LoopState;
  readonly calls: CallModels;
  readonly state: OutcomeState;
  readonly ingress: IngressModel;
}

interface Fixtures {
  readonly ctx: SimulationContext;
  readonly operations: readonly OperationModel[];
  readonly caches: readonly CacheSpec[];
  readonly connections: readonly Connection[];
  readonly autoscaled: readonly Component[];
  readonly faults: ReadonlyMap<string, ComponentFault>;
  readonly occupancy: ReadonlyMap<string, { all: number; aliases: number }>;
}

function createModel(fixtures: Fixtures): Model {
  const loop = emptyLoopState();
  for (const component of fixtures.autoscaled) loop.replicas.set(component.id, component.replicas);
  const calls = callModels(fixtures.connections, fixtures.faults, loop);
  const state: OutcomeState = {
    callFailure: (step, hotKey) => calls.get(step, hotKey).failure,
    occupancy: (entity) => fixtures.occupancy.get(entity ?? "")?.all ?? 0,
    aliasOccupancy: (entity) => fixtures.occupancy.get(entity ?? "")?.aliases ?? 0,
    hitRatio: (id, entity, hotKey) =>
      (hotKey ? loop.hotHit : loop.hit).get(cacheKey(id, entity)) ?? 0,
    negativeHitRatio: (id, entity) => loop.negativeHit.get(cacheKey(id, entity)) ?? 0,
  };
  return { loop, calls, state, ingress: ingressModel(fixtures.faults, loop) };
}

function profilesOf(model: Model, fixtures: Fixtures, whole = false) {
  return buildProfiles(fixtures.ctx, fixtures.faults, model.loop.replicas, whole);
}

function propagateModel(model: Model, fixtures: Fixtures): Propagation {
  model.calls.reset();
  return propagate(fixtures.operations, model.state, model.calls, model.ingress);
}

const instancesIn =
  (profiles: ReadonlyMap<string, ComponentProfile>) =>
  (id: string): number =>
    profiles.get(id)?.instances ?? 1;

/**
 * Fills the caches at nominal load before anything can fail. Starting the
 * fixed point from cold caches would be a shock of its own: every request
 * misses at once, which can tip designs with aggressive retries into an
 * overloaded state they never leave.
 */
function warmCaches(model: Model, fixtures: Fixtures): void {
  const instances = instancesIn(profilesOf(model, fixtures));
  for (let i = 0; i < WARM_UP_ITERATIONS; i++) {
    const flow = propagateModel(model, fixtures);
    if (relaxCaches(fixtures.caches, flow, model.loop, 0.5, instances) < WARM_UP_TOLERANCE) return;
  }
}

/**
 * Whether a cold start brings any component near capacity. Caches only warm
 * from there and autoscaling only adds instances, so a design that stays well
 * below capacity with every cache empty cannot be tipped into overload by it.
 */
function nearCapacityWhenCold(fixtures: Fixtures): boolean {
  const cold = createModel(fixtures);
  const profiles = profilesOf(cold, fixtures);
  const flow = propagateModel(cold, fixtures);
  return [...profiles].some(
    ([id, profile]) => utilizationOf(flow.loads.get(id), profile) > SHOCK_UTILIZATION,
  );
}

function solve(model: Model, fixtures: Fixtures): { converged: boolean; iterations: number } {
  let iterations = 0;
  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const profiles = profilesOf(model, fixtures);
    const flow = propagateModel(model, fixtures);
    const damping = dampingAt(iterations);
    const delta = Math.max(
      relaxComponents(profiles, flow, model.loop, damping),
      relaxAutoscaling(fixtures.autoscaled, profiles, flow, model.loop, damping),
      relaxConnections(fixtures.connections, profiles, flow, model.loop, damping),
      relaxCaches(fixtures.caches, flow, model.loop, damping, instancesIn(profiles)),
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
function shockTest(
  fixtures: Fixtures,
  healthy: Propagation,
  healthyProfiles: ReadonlyMap<string, ComponentProfile>,
): MetastableComponent[] {
  if (!fixtures.connections.some((c) => c.policy.retries > 0)) return [];
  if (!nearCapacityWhenCold(fixtures)) return [];
  const shocked = createModel(fixtures);
  // An unsettled cold solve proves nothing either way.
  if (!solve(shocked, fixtures).converged) return [];
  const profiles = profilesOf(shocked, fixtures);
  const flow = propagateModel(shocked, fixtures);
  const result: MetastableComponent[] = [];
  for (const [id, profile] of profiles) {
    const load = flow.loads.get(id);
    const utilization = utilizationOf(load, profile);
    const before = healthyProfiles.get(id);
    if (utilization <= 1 || !before || utilizationOf(healthy.loads.get(id), before) > 1) continue;
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
 * probabilities, cache hit ratios, queueing latency, hot shards, overload,
 * autoscaling, faults, and the callers' timeouts, retries, circuit breakers
 * and bulkheads. These feed back on each other (a failing call takes the
 * error branch and may be retried, which shifts load), so the model iterates
 * to a damped fixed point, starting from warm caches. If it does not settle,
 * the metrics are the last iterate and `converged` is false.
 */
export function simulateEnvironment(
  workload: Workload,
  environment: Environment,
  ctx: SimulationContext,
): EnvironmentMetrics {
  const faults = resolveFaults(environment.faults, ctx.attempt, ctx.catalog);
  const fixtures: Fixtures = {
    ctx,
    operations: buildOperations(workload, environment, ctx),
    caches: buildCacheSpecs(workload, buildProfiles(ctx, faults), ctx),
    connections: ctx.attempt.architecture.connections,
    autoscaled: ctx.attempt.architecture.components.filter((c) => c.autoscale),
    faults,
    occupancy: occupancies(workload, ctx),
  };
  const model = createModel(fixtures);
  warmCaches(model, fixtures);
  const { converged, iterations } = solve(model, fixtures);

  // Billed and reported with whole instances.
  const profiles = profilesOf(model, fixtures, true);
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
    operations: summarizeOperations(
      fixtures.operations,
      final.operations,
      model.state,
      model.ingress.pass,
      {
        components,
        callFor: model.calls.get,
        replicaAck: replicaAckMs(workload, ctx),
        timeoutOf: (step) => connections.find((c) => c.id === step.connectionId)?.policy.timeoutMs,
        inProcess: new Set([...profiles].filter(([, p]) => p.inProcess).map(([id]) => id)),
        batchArrivals: final.batchArrivals,
      },
    ),
    components,
    caches: fixtures.caches.map((spec) => summarizeCache(spec, final, model.state)),
    entityHitRatios: new Map(
      [...final.entityLookups].map(([entity, { lookups, hits }]) => [
        entity,
        { lookupRate: lookups, hitRatio: lookups > 0 ? hits / lookups : 0 },
      ]),
    ),
    connections: final.traffic,
    calls: summarizeCalls(final, model.calls.shedOf, model.loop.timedOut),
    monthlyCost: [...components.values()].reduce((sum, c) => sum + c.monthlyCost, 0),
    converged,
    iterations,
    metastable: shockTest(fixtures, final, profiles),
  };
}

function relax(values: Map<string, number>, key: string, target: number, damping: number): number {
  const current = values.get(key) ?? 0;
  const next = current + damping * (target - current);
  values.set(key, next);
  return Math.abs(next - current);
}

/**
 * Overload per component. Calls for the hot key all land on its shard;
 * ordinary calls land there with probability 1/shards.
 */
function relaxComponents(
  profiles: ReadonlyMap<string, ComponentProfile>,
  flow: Propagation,
  loop: LoopState,
  damping: number,
): number {
  let delta = 0;
  for (const [id, profile] of profiles) {
    const { normal, hottest } = shardUtilizations(
      flow.loads.get(id),
      flow.hotLoads.get(id),
      profile,
    );
    const onHot = 1 / profile.shards;
    const ordinary = onHot * dropAt(hottest) + (1 - onHot) * dropAt(normal);
    delta = Math.max(delta, relax(loop.drop, id, ordinary, damping));
    delta = Math.max(delta, relax(loop.hotDrop, id, dropAt(hottest), damping));
  }
  return delta;
}

/**
 * Autoscaled components add instances until utilisation is back at their
 * target, between their minimum (`replicas`) and `max`. Replicas stay
 * continuous while iterating; they are rounded up for billing and reporting.
 */
function relaxAutoscaling(
  autoscaled: readonly Component[],
  profiles: ReadonlyMap<string, ComponentProfile>,
  flow: Propagation,
  loop: LoopState,
  damping: number,
): number {
  let delta = 0;
  for (const component of autoscaled) {
    const profile = profiles.get(component.id);
    const bounds = component.autoscale;
    if (!profile || !bounds) continue;
    const current = loop.replicas.get(component.id) ?? component.replicas;
    const perReplica = utilizationOf(flow.loads.get(component.id), profile) * current;
    const wanted = perReplica / bounds.targetUtilization;
    const target = Math.min(bounds.max, Math.max(component.replicas, wanted));
    const change = relax(loop.replicas, component.id, target, damping);
    delta = Math.max(delta, change / Math.max(1, target));
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
  // Several callers may time out on the same target; its latency is the same for all.
  const latencies = new Map<string, ReturnType<typeof componentLatency>>();
  const latencyOf = (id: string, profile: ComponentProfile) => {
    const known = latencies.get(id);
    if (known) return known;
    const latency = componentLatency(flow.loads.get(id), profile, flow.hotLoads.get(id));
    latencies.set(id, latency);
    return latency;
  };
  for (const connection of connections) {
    const { timeoutMs, maxRps } = connection.policy;
    const profile = profiles.get(connection.to);
    if (timeoutMs !== undefined && profile) {
      const latency = latencyOf(connection.to, profile);
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
