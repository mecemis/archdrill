import {
  type Component,
  type Connection,
  type Environment,
  hasFact,
  type Workload,
} from "@archdrill/model";
import { bucketHitsInput, relaxCaches } from "./cache-loop";
import { NETWORK_RTT_MS } from "./calls";
import type { ComponentProfile } from "./capacity";
import { type ComponentFault, resolveFaults } from "./faults";
import type { OutcomeState } from "./outcomes";
import { pageCacheHitRatio } from "./page-cache";
import {
  IDLE_POOL,
  liveInstances,
  type PoolSpec,
  type PoolState,
  poolSpecs,
  poolState,
} from "./pools";
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
  buildStorageSpecs,
  type CacheSpec,
  cacheKey,
  type OperationModel,
  occupancies,
  type SimulationContext,
  type StorageSpec,
  type StorageState,
} from "./setup";
import {
  componentLatency,
  dropAt,
  type Propagation,
  saturatedLatency,
  shardUtilizations,
  timeoutShare,
  utilizationOf,
} from "./summary";

/**
 * The damped fixed point shared by steady-state environments and timelines:
 * a model (the quantities that iterate) over fixtures (what the design and
 * the environment fix), solved by relaxing every quantity towards what the
 * current loads give.
 */

export const MAX_ITERATIONS = 200;
export const TOLERANCE = 1e-7;
/** Iterations that warm the caches before the fixed point starts, at most. */
const WARM_UP_ITERATIONS = 40;
/** Warm enough: the fixed point finishes relaxing the caches anyway. */
const WARM_UP_TOLERANCE = 1e-4;
/** Damping per iteration: strong feedback (breakers, overload) needs smaller steps if it has not settled. */
export function dampingAt(iteration: number): number {
  if (iteration <= 40) return 0.5;
  return iteration <= 120 ? 0.25 : 0.1;
}

export interface Model {
  readonly loop: LoopState;
  readonly calls: CallModels;
  readonly state: OutcomeState;
  readonly ingress: IngressModel;
}

export interface Fixtures {
  /** Seconds since each cache (by `cacheKey`) started empty; absent for warm caches. */
  readonly cacheWindows: ReadonlyMap<string, number>;
  /** Backlog items per second that consumers and jobs work through (timelines). */
  readonly drains: ReadonlyMap<string, number>;
  /** Replicas are set by a timeline's autoscaler, or held after a lost zone, not solved for. */
  readonly fixedReplicas: boolean;
  /** Replicas autoscaled components start from; their minimum when absent. */
  readonly initialReplicas?: ReadonlyMap<string, number>;
  readonly ctx: SimulationContext;
  /** Clients holding persistent connections in this environment. */
  readonly clientConnections: number;
  readonly operations: readonly OperationModel[];
  readonly caches: readonly CacheSpec[];
  readonly connections: readonly Connection[];
  /** Pools the callers keep to stores that run one statement per connection. */
  readonly pools: readonly PoolSpec[];
  /** Stores that cache pages of their data and read the rest from a volume. */
  readonly stores: readonly StorageSpec[];
  readonly autoscaled: readonly Component[];
  readonly faults: ReadonlyMap<string, ComponentFault>;
  readonly occupancy: ReadonlyMap<string, { all: number; aliases: number }>;
}

/**
 * A model over the fixtures. Timelines pass the previous step's loop state,
 * so each step starts where the last one ended.
 */
export function createModel(fixtures: Fixtures, previous?: LoopState): Model {
  const loop = previous ?? emptyLoopState();
  if (!previous) {
    for (const c of fixtures.autoscaled) {
      loop.replicas.set(c.id, fixtures.initialReplicas?.get(c.id) ?? c.replicas);
    }
  }
  const calls = callModels(fixtures.connections, fixtures.faults, loop);
  const existsFor = new Map(
    fixtures.ctx.problem.entities.flatMap((e) => (e.existsFor ? [[e.name, e.existsFor]] : [])),
  );
  const state: OutcomeState = {
    exists: (entity, cls) => {
      const fact = existsFor.get(entity ?? "");
      return fact === undefined ? cls.exists : hasFact(cls, fact);
    },
    callFailure: (step, hotKey) => calls.get(step, hotKey).failure,
    occupancy: (entity) => fixtures.occupancy.get(entity ?? "")?.all ?? 0,
    aliasOccupancy: (entity) => fixtures.occupancy.get(entity ?? "")?.aliases ?? 0,
    hitRatio: (id, entity, hotKey) =>
      (hotKey ? loop.hotHit : loop.hit).get(cacheKey(id, entity)) ?? 0,
    negativeHitRatio: (id, entity) => loop.negativeHit.get(cacheKey(id, entity)) ?? 0,
  };
  return { loop, calls, state, ingress: ingressModel(fixtures.faults, loop) };
}

export function profilesOf(model: Model, fixtures: Fixtures, whole = false) {
  const states = new Map<string, StorageState>(
    fixtures.stores.map((spec) => [
      spec.componentId,
      {
        ioPerRead: model.loop.ioPerRead.get(spec.componentId) ?? 0,
        hitRatio: model.loop.pageHit.get(spec.componentId) ?? 1,
      },
    ]),
  );
  return buildProfiles(
    fixtures.ctx,
    fixtures.faults,
    model.loop.replicas,
    whole,
    fixtures.clientConnections,
    { specs: fixtures.stores, states },
  );
}

export function propagateModel(model: Model, fixtures: Fixtures): Propagation {
  model.calls.reset();
  return propagate(fixtures.operations, model.state, model.calls, model.ingress, fixtures.drains);
}

export const instancesIn =
  (profiles: ReadonlyMap<string, ComponentProfile>) =>
  (id: string): number =>
    profiles.get(id)?.instances ?? 1;

/**
 * Fills the caches at nominal load before anything can fail. Starting the
 * fixed point from cold caches would be a shock of its own: every request
 * misses at once, which can tip designs with aggressive retries into an
 * overloaded state they never leave.
 */
export function warmCaches(model: Model, fixtures: Fixtures): void {
  const instances = instancesIn(profilesOf(model, fixtures));
  for (let i = 0; i < WARM_UP_ITERATIONS; i++) {
    const flow = propagateModel(model, fixtures);
    const delta = relaxCaches(fixtures.caches, flow, model.loop, 0.5, instances, (key) =>
      fixtures.cacheWindows.get(key),
    );
    if (delta < WARM_UP_TOLERANCE) return;
  }
}

/** What a design and an environment fix while the model iterates. */
export function buildFixtures(
  workload: Workload,
  environment: Environment,
  ctx: SimulationContext,
  faults: ReadonlyMap<string, ComponentFault> = resolveFaults(
    environment.faults,
    ctx.attempt,
    ctx.catalog,
  ),
  caches: readonly CacheSpec[] = buildCacheSpecs(workload, buildProfiles(ctx, faults), ctx),
  occupancy: ReadonlyMap<string, { all: number; aliases: number }> = occupancies(workload, ctx),
): Fixtures {
  return {
    cacheWindows: new Map(),
    drains: new Map(),
    fixedReplicas: false,
    ctx,
    clientConnections: environment.connections,
    operations: buildOperations(workload, environment, ctx),
    caches,
    connections: ctx.attempt.architecture.connections,
    pools: poolSpecs(ctx),
    stores: buildStorageSpecs(workload, ctx),
    autoscaled: ctx.attempt.architecture.components.filter((c) => c.autoscale),
    faults,
    occupancy,
  };
}

export function solve(
  model: Model,
  fixtures: Fixtures,
  maxIterations = MAX_ITERATIONS,
  tolerance = TOLERANCE,
): { converged: boolean; iterations: number } {
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations++;
    const profiles = profilesOf(model, fixtures);
    const flow = propagateModel(model, fixtures);
    const damping = dampingAt(iterations);
    const delta = Math.max(
      relaxComponents(profiles, flow, model.loop, damping),
      fixtures.fixedReplicas
        ? 0
        : relaxAutoscaling(fixtures.autoscaled, profiles, flow, model.loop, damping),
      relaxConnections(fixtures.connections, profiles, flow, model.loop, damping),
      relaxPools(fixtures.pools, profiles, flow, fixtures.faults, model.loop, damping),
      relaxCaches(fixtures.caches, flow, model.loop, damping, instancesIn(profiles), (key) =>
        fixtures.cacheWindows.get(key),
      ),
      relaxStorage(fixtures, flow, model.loop, damping, instancesIn(profiles)),
    );
    if (delta < tolerance) return { converged: true, iterations };
  }
  return { converged: false, iterations };
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
    // Ordinary keys share the hot key's shard; a per-key limit throttles the hot key alone.
    const onHot = profile.sharded ? 1 / profile.shards : 0;
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

/**
 * Page caches follow the reads: each entity's reads, by the caches they
 * missed on the way, give its hit ratio; the pages of the reads that miss
 * are what the store reads from its volume.
 */
function relaxStorage(
  fixtures: Fixtures,
  flow: Propagation,
  loop: LoopState,
  damping: number,
  instancesOf: (componentId: string) => number,
): number {
  let delta = 0;
  const caches = new Map(fixtures.caches.map((c) => [cacheKey(c.componentId, c.entity), c]));
  for (const spec of fixtures.stores) {
    const read = [...spec.popularity].flatMap(([entity, popularity]) => {
      const ways = flow.storeReads.get(cacheKey(spec.componentId, entity));
      const rate = ways ? [...ways.values()].reduce((sum, r) => sum + r, 0) : 0;
      return ways && rate > 0 ? [{ entity, popularity, ways, rate }] : [];
    });
    // The entities read from it share its memory.
    const cachedKeys = spec.cachedKeys / Math.max(1, read.length);
    let io = 0;
    let hits = 0;
    let reads = 0;
    for (const { entity, popularity, ways, rate } of read) {
      const streams = [...ways].map(([way, wayRate]) => ({
        rate: wayRate,
        missed: (way === "" ? [] : way.split(",")).flatMap((cacheId) => {
          const cache = caches.get(cacheKey(cacheId, entity));
          const missedCache = cache
            ? bucketHitsInput(cache, flow, loop, instancesOf, (key) =>
                fixtures.cacheWindows.get(key),
              )
            : null;
          return missedCache ? [missedCache] : [];
        }),
      }));
      const hit = pageCacheHitRatio(popularity, spec.shards, cachedKeys, streams);
      io += rate * (1 - hit) * spec.pagesPerRead;
      hits += rate * hit;
      reads += rate;
    }
    const readLoad = flow.loads.get(spec.componentId)?.read ?? 0;
    const ioTarget = readLoad > 0 ? io / readLoad : 0;
    const hitTarget = reads > 0 ? hits / reads : 1;
    // Relative to a page a read, so the tolerance means the same for any store.
    delta = Math.max(delta, relax(loop.ioPerRead, spec.componentId, ioTarget, damping));
    delta = Math.max(delta, relax(loop.pageHit, spec.componentId, hitTarget, damping));
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

/** Milliseconds a call holds its pooled connection: the store's latency, the round trip and any proxy. */
function holdMs(
  spec: PoolSpec,
  profiles: ReadonlyMap<string, ComponentProfile>,
  flow: Propagation,
): number {
  const profile = profiles.get(spec.target);
  if (!profile) return 0;
  const latency = componentLatency(
    flow.loads.get(spec.target),
    profile,
    flow.hotLoads.get(spec.target),
  );
  // The pools themselves keep the store's queue from growing without end.
  const served = Math.min(latency.mean, saturatedLatency(profile).mean);
  return served + NETWORK_RTT_MS + spec.proxyMs;
}

/** How full each caller's pools are, from the attempts it makes and how long each holds a connection. */
export function poolStates(
  pools: readonly PoolSpec[],
  profiles: ReadonlyMap<string, ComponentProfile>,
  flow: Propagation,
  faults: ReadonlyMap<string, ComponentFault>,
): Map<string, PoolState> {
  return new Map(
    pools.map((spec) => {
      const attempts = flow.calls.get(spec.connectionId)?.attempts ?? 0;
      const instances = liveInstances(spec.caller, profiles, faults);
      const state =
        attempts > 0
          ? poolState(spec, attempts, instances, holdMs(spec, profiles, flow))
          : IDLE_POOL;
      return [spec.connectionId, state];
    }),
  );
}

/** Pools follow the calls: more in flight than connections leaves attempts waiting. */
function relaxPools(
  pools: readonly PoolSpec[],
  profiles: ReadonlyMap<string, ComponentProfile>,
  flow: Propagation,
  faults: ReadonlyMap<string, ComponentFault>,
  loop: LoopState,
  damping: number,
): number {
  let delta = 0;
  for (const [id, state] of poolStates(pools, profiles, flow, faults)) {
    delta = Math.max(delta, relax(loop.poolExhausted, id, state.exhausted, damping));
    // Relative change, so the tolerance means the same for any wait.
    const change = relax(loop.poolWait, id, state.waitMs, damping);
    delta = Math.max(delta, change / Math.max(1, state.waitMs));
  }
  return delta;
}
