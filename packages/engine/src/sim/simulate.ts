import {
  ACTIONS,
  type Attempt,
  type CatalogIndex,
  type Environment,
  liveStepIds,
  type Operation,
  type Problem,
  type RequestClass,
  type Workload,
  type Zipf,
} from "@archdrill/model";
import type { Analysis, OperationAnalysis } from "../analyze";
import type { Path } from "../paths/types";
import { cacheHitRatio } from "./cache-model";
import {
  type ComponentProfile,
  componentProfile,
  HOURS_PER_MONTH,
  SECONDS_PER_MONTH,
} from "./capacity";
import { type Moments, mixtureQuantile, type WeightedMoments } from "./math/gamma";
import { queueWait } from "./math/queueing";
import { callShare, type OutcomeState, outcomeProbability } from "./outcomes";
import type {
  CacheMetrics,
  ComponentMetrics,
  EnvironmentMetrics,
  LatencySummary,
  OperationMetrics,
  PathMetrics,
} from "./types";

/** Round trip of one network hop inside a zone. */
export const NETWORK_RTT_MS = 0.5;
/**
 * Extra wait for requests that an overloaded component does serve: its queue
 * keeps growing until callers give up. Until timeouts are modelled this is a
 * fixed, documented assumption of about a second.
 */
export const OVERLOAD_WAIT_MS = 1000;
/** Share of cache memory usable for entries (allocator and metadata overhead). */
export const CACHE_FILL_FACTOR = 0.7;
const MAX_ITERATIONS = 80;
const TOLERANCE = 1e-7;
const DAMPING = 0.5;

const DEFAULT_CLASS: RequestClass = {
  id: "default",
  share: 1,
  exists: true,
  expired: false,
  disabled: false,
  invalidInput: false,
  customAlias: false,
  aliasTaken: false,
};

export interface SimulationContext {
  readonly attempt: Attempt;
  readonly catalog: CatalogIndex;
  readonly problem: Problem;
  readonly analysis: Analysis;
}

interface OperationModel {
  readonly operation: Operation;
  readonly rate: number;
  readonly analysis: OperationAnalysis;
  readonly classes: readonly RequestClass[];
  /** Ingress components that do work (the client is excluded), in order. */
  readonly ingress: readonly string[];
}

interface CacheSpec {
  readonly componentId: string;
  readonly entity: string;
  readonly populated: boolean;
  readonly ttlSec: number | null;
  readonly negativePopulated: boolean;
  readonly negativeTtlSec: number | null;
  readonly capacityItems: number;
  readonly existing: Zipf | undefined;
  readonly absent: Zipf | undefined;
}

interface Propagation {
  readonly loads: Map<string, { read: number; write: number }>;
  readonly lookups: Map<string, { existing: number; absent: number }>;
  readonly connections: Map<string, number>;
}

const cacheKey = (componentId: string, entity: string | undefined) =>
  `${componentId}|${entity ?? ""}`;

/**
 * Steady-state model of one environment: load propagation over path
 * probabilities, cache hit ratios, queueing latency and overload. Overload
 * feeds back (rejected calls take error branches, which shift load), so the
 * model iterates to a damped fixed point.
 */
export function simulateEnvironment(
  workload: Workload,
  environment: Environment,
  ctx: SimulationContext,
): EnvironmentMetrics {
  const profiles = buildProfiles(ctx);
  const operations = buildOperations(workload, environment, ctx);
  const caches = buildCacheSpecs(workload, profiles, ctx);
  const drop = new Map<string, number>();
  const hit = new Map<string, number>();
  const negativeHit = new Map<string, number>();
  const occupancyByEntity = occupancies(workload, ctx);
  const state: OutcomeState = {
    occupancy: (entity) => occupancyByEntity.get(entity ?? "")?.all ?? 0,
    aliasOccupancy: (entity) => occupancyByEntity.get(entity ?? "")?.aliases ?? 0,
    dropRate: (id) => drop.get(id) ?? 0,
    hitRatio: (id, entity) => hit.get(cacheKey(id, entity)) ?? 0,
    negativeHitRatio: (id, entity) => negativeHit.get(cacheKey(id, entity)) ?? 0,
  };

  let iterations = 0;
  let converged = false;
  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const flow = propagate(operations, state);
    let delta = 0;
    for (const [id, profile] of profiles) {
      const target = dropFor(flow.loads.get(id), profile);
      delta = Math.max(delta, relax(drop, id, target));
    }
    for (const spec of caches) {
      const key = cacheKey(spec.componentId, spec.entity);
      const lookups = flow.lookups.get(key) ?? { existing: 0, absent: 0 };
      const [positiveItems, negativeItems] = splitCapacity(spec, lookups);
      delta = Math.max(delta, relax(hit, key, hitFor(spec, lookups.existing, positiveItems)));
      delta = Math.max(
        delta,
        relax(negativeHit, key, negativeHitFor(spec, lookups.absent, negativeItems)),
      );
    }
    if (delta < TOLERANCE) {
      converged = true;
      break;
    }
  }

  const final = propagate(operations, state);
  const components = summarizeComponents(profiles, final, drop, storedGb(workload, ctx));
  return {
    environment,
    operations: summarizeOperations(operations, state, components),
    components,
    caches: caches.map((spec) => summarizeCache(spec, final, state)),
    connections: final.connections,
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

function utilizationOf(
  load: { read: number; write: number } | undefined,
  profile: ComponentProfile,
): number {
  if (!load) return 0;
  const read = Number.isFinite(profile.readCapacity) ? load.read / profile.readCapacity : 0;
  const write = Number.isFinite(profile.writeCapacity) ? load.write / profile.writeCapacity : 0;
  return read + write;
}

/** Beyond capacity, the excess share of arrivals is rejected. */
function dropFor(
  load: { read: number; write: number } | undefined,
  profile: ComponentProfile,
): number {
  const rho = utilizationOf(load, profile);
  return rho > 1 ? 1 - 1 / rho : 0;
}

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

function buildProfiles(ctx: SimulationContext): Map<string, ComponentProfile> {
  const profiles = new Map<string, ComponentProfile>();
  for (const component of ctx.attempt.architecture.components) {
    const profile = componentProfile(component, ctx.catalog);
    if (profile) profiles.set(component.id, profile);
  }
  return profiles;
}

function buildOperations(
  workload: Workload,
  environment: Environment,
  ctx: SimulationContext,
): OperationModel[] {
  const models: OperationModel[] = [];
  for (const [operationId, rate] of Object.entries(environment.rates)) {
    const analysis = ctx.analysis.operations.get(operationId);
    if (rate <= 0 || !analysis || analysis.status !== "ready") continue;
    const ingress = (analysis.ingress?.components ?? []).filter((id) => {
      const c = ctx.attempt.architecture.components.find((x) => x.id === id);
      return c ? !ctx.catalog.capabilities(c.kind, c.flavor).has("traffic-source") : false;
    });
    models.push({
      operation: analysis.operation,
      rate,
      analysis,
      classes: workload.operations[operationId]?.classes ?? [DEFAULT_CLASS],
      ingress,
    });
  }
  return models;
}

/** One spec per (cache component, entity) that some live step looks up. */
function buildCacheSpecs(
  workload: Workload,
  profiles: ReadonlyMap<string, ComponentProfile>,
  ctx: SimulationContext,
): CacheSpec[] {
  const liveCalls = ctx.attempt.flows.flatMap((flow) =>
    liveStepIds(flow, ctx.attempt).flatMap((id) => {
      const step = flow.steps[id];
      return step?.type === "call" ? [step] : [];
    }),
  );
  const lookups = new Map<string, { componentId: string; entity: string }>();
  for (const step of liveCalls) {
    if (step.action === "cache.get" && step.entity) {
      lookups.set(cacheKey(step.target, step.entity), {
        componentId: step.target,
        entity: step.entity,
      });
    }
  }
  const entitiesPerCache = new Map<string, number>();
  for (const { componentId } of lookups.values()) {
    entitiesPerCache.set(componentId, (entitiesPerCache.get(componentId) ?? 0) + 1);
  }
  const minTtl = (action: string, componentId: string, entity: string) => {
    const ttls = liveCalls
      .filter((s) => s.action === action && s.target === componentId && s.entity === entity)
      .map((s) => s.ttlSec ?? Number.POSITIVE_INFINITY);
    if (ttls.length === 0) return { present: false, ttl: null };
    const ttl = Math.min(...ttls);
    return { present: true, ttl: Number.isFinite(ttl) ? ttl : null };
  };
  return [...lookups.values()].map(({ componentId, entity }) => {
    const entityBytes = ctx.problem.entities.find((e) => e.name === entity)?.avgBytes ?? 1;
    const memoryGb = profiles.get(componentId)?.memoryGb ?? 0;
    const share = entitiesPerCache.get(componentId) ?? 1;
    const positive = minTtl("cache.set", componentId, entity);
    const negative = minTtl("cache.setNegative", componentId, entity);
    return {
      componentId,
      entity,
      populated: positive.present,
      ttlSec: positive.ttl,
      negativePopulated: negative.present,
      negativeTtlSec: negative.ttl,
      capacityItems: (memoryGb * 1e9 * CACHE_FILL_FACTOR) / entityBytes / share,
      existing: workload.keys[entity]?.existing,
      absent: workload.keys[entity]?.absent,
    };
  });
}

function pathProbability(path: Path, cls: RequestClass, state: OutcomeState): number {
  let probability = 1;
  path.steps.forEach((step, index) => {
    if (probability === 0) return;
    probability *= outcomeProbability(step, cls, state, path.steps.slice(0, index));
  });
  return probability;
}

interface Occupancy {
  /** Share of the keyspace taken by stored codes. */
  readonly all: number;
  /** Share of the keyspace taken by custom aliases. */
  readonly aliases: number;
}

/**
 * Share of the keyspace already taken, per entity, from the dataset size and
 * the code-length decision. Custom aliases are assumed to be as long as
 * generated codes, an upper bound: shorter or longer aliases cannot collide.
 */
function occupancies(workload: Workload, ctx: SimulationContext): Map<string, Occupancy> {
  const result = new Map<string, Occupancy>();
  for (const [entity, { alphabet, lengthDecision }] of Object.entries(workload.keyspace)) {
    const point = ctx.problem.decisionPoints.find((d) => d.id === lengthDecision);
    const length = Number(ctx.attempt.decisions[lengthDecision] ?? point?.default);
    const stored = workload.dataset[entity] ?? 0;
    if (!Number.isFinite(length) || length <= 0) continue;
    const all = Math.min(1, stored / alphabet ** length);
    result.set(entity, { all, aliases: all * customAliasShare(workload, entity) });
  }
  return result;
}

/** Share of stored codes that are custom aliases, from the classes of operations that create them. */
function customAliasShare(workload: Workload, entity: string): number {
  let share = 0;
  for (const op of Object.values(workload.operations)) {
    if (op.entity !== entity || !op.classes.some((c) => c.customAlias)) continue;
    const stored = op.classes.filter((c) => !c.invalidInput && !c.aliasTaken);
    const total = stored.reduce((sum, c) => sum + c.share, 0);
    const aliases = stored.filter((c) => c.customAlias).reduce((sum, c) => sum + c.share, 0);
    if (total > 0) share = Math.max(share, aliases / total);
  }
  return share;
}

/** Share of requests that make it through every ingress hop. */
function ingressPass(op: OperationModel, state: OutcomeState): number {
  return op.ingress.reduce((pass, id) => pass * (1 - state.dropRate(id)), 1);
}

function propagate(operations: readonly OperationModel[], state: OutcomeState): Propagation {
  const loads = new Map<string, { read: number; write: number }>();
  const lookups = new Map<string, { existing: number; absent: number }>();
  const connections = new Map<string, number>();
  const addLoad = (id: string, rate: number, write: boolean) => {
    const load = loads.get(id) ?? { read: 0, write: 0 };
    if (write) load.write += rate;
    else load.read += rate;
    loads.set(id, load);
  };
  const addConnection = (id: string | null, rate: number) => {
    if (id !== null) connections.set(id, (connections.get(id) ?? 0) + rate);
  };

  for (const op of operations) {
    const isWrite = op.operation.class === "write";
    let arriving = op.rate;
    const route = op.analysis.ingress;
    route?.connections.forEach((connectionId, index) => {
      const hop = route.components[index + 1];
      addConnection(connectionId, arriving);
      if (hop && op.ingress.includes(hop)) {
        addLoad(hop, arriving, isWrite);
        arriving *= 1 - state.dropRate(hop);
      }
    });
    for (const cls of op.classes) {
      for (const path of op.analysis.paths) {
        const weight = arriving * cls.share * pathProbability(path, cls, state);
        if (weight === 0) continue;
        for (const step of path.steps) {
          if (step.kind !== "call") continue;
          const calls = weight * callShare(step);
          addLoad(step.target, calls, ACTIONS[step.action].effect !== "read");
          addConnection(step.connectionId, calls);
          if (step.action === "cache.get") {
            const entry = lookups.get(cacheKey(step.target, step.entity)) ?? {
              existing: 0,
              absent: 0,
            };
            if (cls.exists) entry.existing += weight;
            else entry.absent += weight;
            lookups.set(cacheKey(step.target, step.entity), entry);
          }
        }
      }
    }
  }
  return { loads, lookups, connections };
}

/** Gigabytes of entity data each component holds (one copy), from the workload's dataset sizes. */
function storedGb(workload: Workload, ctx: SimulationContext): Map<string, number> {
  const result = new Map<string, number>();
  for (const component of ctx.attempt.architecture.components) {
    const gb = component.data.reduce((sum, binding) => {
      const entity = ctx.problem.entities.find((e) => e.name === binding.entity);
      const count = workload.dataset[binding.entity] ?? 0;
      return sum + (entity ? (count * entity.avgBytes) / 1e9 : 0);
    }, 0);
    if (gb > 0) result.set(component.id, gb);
  }
  return result;
}

function summarizeComponents(
  profiles: ReadonlyMap<string, ComponentProfile>,
  flow: Propagation,
  drop: ReadonlyMap<string, number>,
  stored: ReadonlyMap<string, number>,
): Map<string, ComponentMetrics> {
  const metrics = new Map<string, ComponentMetrics>();
  for (const [id, profile] of profiles) {
    const load = flow.loads.get(id) ?? { read: 0, write: 0 };
    const utilization = utilizationOf(load, profile);
    const wait =
      utilization > 1
        ? OVERLOAD_WAIT_MS
        : queueWait(utilization, profile.servers, profile.serviceTimeMs);
    const service = profile.serviceTimeMs;
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
      utilization,
      dropRate: drop.get(id) ?? 0,
      latency: { mean: service + wait, variance: (profile.cv * service) ** 2 + wait ** 2 },
      storageGb,
      monthlyCost: instanceCost + requestCost + storageCost,
      costBreakdown: { instances: instanceCost, requests: requestCost, storage: storageCost },
    });
  }
  return metrics;
}

function addMoments(a: Moments, b: Moments): Moments {
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

const NETWORK_HOP: Moments = { mean: NETWORK_RTT_MS, variance: (0.2 * NETWORK_RTT_MS) ** 2 };

function pathLatency(
  path: Path,
  ingressLatency: Moments,
  components: ReadonlyMap<string, ComponentMetrics>,
  state: OutcomeState,
): Moments {
  let total = ingressLatency;
  for (const step of path.steps) {
    if (step.kind !== "call") continue;
    // A rejected call fails fast: it costs the round trip, not the service time.
    const rejected = step.outcome === "error" && state.dropRate(step.target) > 0;
    const latency = components.get(step.target)?.latency;
    const call = latency && !rejected ? addMoments(NETWORK_HOP, latency) : NETWORK_HOP;
    // Batched allocation: only one request in a batch pays for the call.
    total = addMoments(total, mixMoments(call, callShare(step)));
  }
  return total;
}

function summarize(components: readonly WeightedMoments[]): LatencySummary {
  const total = components.reduce((sum, c) => sum + c.weight, 0);
  return {
    mean: total > 0 ? components.reduce((sum, c) => sum + c.weight * c.mean, 0) / total : 0,
    p50: mixtureQuantile(components, 0.5),
    p95: mixtureQuantile(components, 0.95),
    p99: mixtureQuantile(components, 0.99),
  };
}

function summarizeOperations(
  operations: readonly OperationModel[],
  state: OutcomeState,
  components: ReadonlyMap<string, ComponentMetrics>,
): Map<string, OperationMetrics> {
  const result = new Map<string, OperationMetrics>();
  for (const op of operations) {
    const hops = op.analysis.ingress?.connections.length ?? 0;
    let ingressLatency: Moments = {
      mean: hops * NETWORK_HOP.mean,
      variance: hops * NETWORK_HOP.variance,
    };
    for (const id of op.ingress) {
      const latency = components.get(id)?.latency;
      if (latency) ingressLatency = addMoments(ingressLatency, latency);
    }
    const pass = ingressPass(op, state);
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
      const moments = pathLatency(path, ingressLatency, components, state);
      const status = path.terminal.kind === "respond" ? path.terminal.status : null;
      if (status === null) unhandled += probability;
      else if (op.operation.successStatuses.includes(status)) success += probability;
      else errorStatus += probability;
      paths.push({ pathId: path.id, probability, latency: summarize([{ weight: 1, ...moments }]) });
      // Latency is measured on successful requests: fast failures would otherwise pull the tail down.
      if (status !== null && op.operation.successStatuses.includes(status)) {
        mixture.push({ weight: pass * probability, ...moments });
      }
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

function summarizeCache(spec: CacheSpec, flow: Propagation, state: OutcomeState): CacheMetrics {
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
