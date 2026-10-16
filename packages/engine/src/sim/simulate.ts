import type { Environment, Workload } from "@archdrill/model";
import type { ComponentProfile } from "./capacity";
import { resolveFaults } from "./faults";
import {
  buildFixtures,
  createModel,
  type Fixtures,
  profilesOf,
  propagateModel,
  solve,
  warmCaches,
} from "./model";
import { replicaAckMs, type SimulationContext, storedGb, wholeInstances } from "./setup";
import {
  type Propagation,
  summarizeCache,
  summarizeCalls,
  summarizeComponents,
  summarizeOperations,
  utilizationOf,
} from "./summary";
import type { EnvironmentMetrics, MetastableComponent } from "./types";

export { NETWORK_RTT_MS } from "./calls";
export { MAX_DELIVERIES } from "./propagate";
export { CACHE_FILL_FACTOR, type SimulationContext } from "./setup";
export { OVERLOAD_WAIT_MS } from "./summary";

/**
 * Below this utilisation at a cold start, nothing is close enough to
 * capacity for retries to tip it over, so the shock test can be skipped.
 */
const SHOCK_UTILIZATION = 0.8;

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
 * A lost zone is survived with the instances already running: launching
 * new ones depends on a control plane that the outage may impair, and takes
 * minutes anyway (static stability). Autoscaled components keep the whole
 * instances they ran for the same load before the zone was lost, or null
 * when the environment loses no zone.
 */
function instancesBeforeZoneLoss(
  workload: Workload,
  environment: Environment,
  ctx: SimulationContext,
): Map<string, number> | null {
  if (!environment.faults.some((f) => f.kind === "zone-down")) return null;
  const healthy = {
    ...environment,
    faults: environment.faults.filter((f) => f.kind !== "zone-down"),
  };
  const fixtures = buildFixtures(workload, healthy, ctx);
  const model = createModel(fixtures);
  warmCaches(model, fixtures);
  solve(model, fixtures);
  return new Map([...model.loop.replicas].map(([id, replicas]) => [id, wholeInstances(replicas)]));
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
  const before = instancesBeforeZoneLoss(workload, environment, ctx);
  // A lost zone takes its share of the instances that actually ran.
  const lost = before && resolveFaults(environment.faults, ctx.attempt, ctx.catalog, before);
  const fixtures: Fixtures = {
    ...buildFixtures(workload, environment, ctx, lost ?? undefined),
    ...(before && { fixedReplicas: true, initialReplicas: before }),
  };
  const faults = fixtures.faults;
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
    { ...ctx.problem.client, held: fixtures.clientConnections },
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
