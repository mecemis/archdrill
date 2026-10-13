import {
  type Attempt,
  type CatalogIndex,
  type Component,
  type Environment,
  liveStepIds,
  type Operation,
  type Problem,
  REPLICATION_MODES,
  type ReplicationMode,
  type RequestClass,
  type Workload,
  type Zipf,
} from "@archdrill/model";
import type { Analysis, OperationAnalysis } from "../analyze";
import { type ComponentProfile, componentProfile } from "./capacity";
import { type ComponentFault, faultedProfile, NO_FAULT } from "./faults";

/** Share of cache memory usable for entries (allocator and metadata overhead). */
export const CACHE_FILL_FACTOR = 0.7;
/** Round trip to a replica in another zone, which semi-synchronous replication waits for. */
export const CROSS_ZONE_RTT_MS = 1;

const REPLICA_ACK_MS: Readonly<Record<ReplicationMode, number>> = {
  async: 0,
  "semi-sync": CROSS_ZONE_RTT_MS,
  // Waiting for every replica means waiting for the slowest one, and for its disk.
  sync: 2 * CROSS_ZONE_RTT_MS,
};

const DEFAULT_CLASS: RequestClass = {
  id: "default",
  share: 1,
  exists: true,
  expired: false,
  disabled: false,
  invalidInput: false,
  customAlias: false,
  aliasTaken: false,
  hotKey: false,
  malicious: false,
};

export interface SimulationContext {
  readonly attempt: Attempt;
  readonly catalog: CatalogIndex;
  readonly problem: Problem;
  readonly analysis: Analysis;
}

export interface OperationModel {
  readonly operation: Operation;
  /**
   * Requests (or a job's items) per second. Consumers of an event have no
   * rate of their own: theirs follows from the messages published to them.
   */
  readonly rate: number;
  readonly analysis: OperationAnalysis;
  /** Request classes; a consumer's classes are those of the messages it receives. */
  readonly classes: readonly RequestClass[];
  /** Components on the way to the handler that do work (the client is excluded), in order. */
  readonly ingress: readonly string[];
  /** Events the operation's flow publishes. */
  readonly publishes: ReadonlySet<string>;
  /** Popularity of the keys requests address, for handlers that aggregate per key. */
  readonly keyPopularity: Zipf | undefined;
  /**
   * Steps on entities keyed by something other than the request's key (an
   * event id rather than a link code): a hot key does not make them hot.
   */
  readonly unkeyed: ReadonlySet<string>;
}

export interface CacheSpec {
  readonly componentId: string;
  /** For an in-process cache: the service it lives in, one copy per instance of it. */
  readonly callerOf: string | null;
  readonly entity: string;
  readonly populated: boolean;
  readonly ttlSec: number | null;
  readonly negativePopulated: boolean;
  readonly negativeTtlSec: number | null;
  readonly capacityItems: number;
  readonly existing: Zipf | undefined;
  readonly absent: Zipf | undefined;
  /**
   * Every store read behind this cache coalesces concurrent misses for a key
   * (single-flight), so a cold key costs one read, not one per waiting request.
   */
  readonly coalesced: boolean;
}

export const cacheKey = (componentId: string, entity: string | undefined) =>
  `${componentId}|${entity ?? ""}`;

/**
 * Rounds autoscaled replicas up to whole instances, with a tolerance for the
 * fixed point stopping a hair above an exact count.
 */
export function wholeInstances(replicas: number): number {
  return Math.ceil(replicas - 1e-6 * Math.max(1, replicas));
}

/**
 * Capacity and latency of every component that does work, under the
 * environment's faults, with autoscaled components at the given replicas
 * (rounded up to whole instances when `whole` is set, as they are billed).
 */
export function buildProfiles(
  ctx: SimulationContext,
  faults: ReadonlyMap<string, ComponentFault>,
  scaled: ReadonlyMap<string, number> = new Map(),
  whole = false,
): Map<string, ComponentProfile> {
  const profiles = new Map<string, ComponentProfile>();
  for (const component of ctx.attempt.architecture.components) {
    const replicas = component.autoscale ? scaled.get(component.id) : undefined;
    const profile = componentProfile(
      component,
      ctx.catalog,
      replicas === undefined ? undefined : whole ? wholeInstances(replicas) : replicas,
    );
    if (profile)
      profiles.set(component.id, faultedProfile(profile, faults.get(component.id) ?? NO_FAULT));
  }
  return profiles;
}

/** The operation's request classes, with this environment's share overrides. */
function classesIn(
  workload: Workload,
  environment: Environment,
  operationId: string,
): RequestClass[] {
  const classes = workload.operations[operationId]?.classes ?? [DEFAULT_CLASS];
  const shares = environment.classShares[operationId] ?? {};
  return classes.map((cls) => ({ ...cls, share: shares[cls.id] ?? cls.share }));
}

export function buildOperations(
  workload: Workload,
  environment: Environment,
  ctx: SimulationContext,
): OperationModel[] {
  const ready = (id: string) => {
    const analysis = ctx.analysis.operations.get(id);
    return analysis?.status === "ready" ? analysis : undefined;
  };
  const model = (analysis: OperationAnalysis, rate: number, classes: RequestClass[]) => ({
    operation: analysis.operation,
    rate,
    analysis,
    classes,
    ...requestKeys(analysis, workload, ctx.problem),
    ingress: (analysis.ingress?.components ?? []).filter((id) => {
      const c = ctx.attempt.architecture.components.find((x) => x.id === id);
      return c ? !ctx.catalog.capabilities(c.kind, c.flavor).has("traffic-source") : false;
    }),
    publishes: publishedEvents(analysis),
  });
  const models: OperationModel[] = [];
  for (const [operationId, rate] of Object.entries(environment.rates)) {
    const analysis = ready(operationId);
    if (rate <= 0 || !analysis || analysis.operation.trigger.type === "event") continue;
    models.push(model(analysis, rate, classesIn(workload, environment, operationId)));
  }
  for (const operation of ctx.problem.operations) {
    const analysis = ready(operation.id);
    // A consumer without a route to a queue that receives its event never runs.
    if (analysis?.ingress && operation.trigger.type === "event") {
      models.push(model(analysis, 0, []));
    }
  }
  return publishersFirst(models);
}

/** The entity a request addresses: its workload's, or for a consumer its event's. */
function requestEntity(operation: Operation, workload: Workload, problem: Problem) {
  const trigger = operation.trigger;
  const name =
    trigger.type === "event"
      ? problem.events.find((e) => e.id === trigger.event)?.entity
      : workload.operations[operation.id]?.entity;
  return name === undefined ? undefined : problem.entities.find((e) => e.name === name);
}

function requestKeys(
  analysis: OperationAnalysis,
  workload: Workload,
  problem: Problem,
): Pick<OperationModel, "keyPopularity" | "unkeyed"> {
  const entity = requestEntity(analysis.operation, workload, problem);
  const keyOf = (name: string) => problem.entities.find((e) => e.name === name)?.key;
  const unkeyed = new Set<string>();
  for (const path of analysis.paths) {
    for (const step of path.steps) {
      if (step.kind === "call" && step.entity && entity && keyOf(step.entity) !== entity.key) {
        unkeyed.add(step.stepId);
      }
    }
  }
  return {
    keyPopularity: entity ? workload.keys[entity.name]?.existing : undefined,
    unkeyed,
  };
}

function publishedEvents(analysis: OperationAnalysis): Set<string> {
  const events = new Set<string>();
  for (const path of analysis.paths) {
    for (const step of path.steps) {
      if (step.kind === "call" && step.action === "queue.publish" && step.event) {
        events.add(step.event);
      }
    }
  }
  return events;
}

/**
 * Orders operations so that every consumer comes after the operations that
 * publish its event, and one propagation pass knows each consumer's rate.
 * Consumers that publish to each other in a cycle keep their order.
 */
function publishersFirst(models: readonly OperationModel[]): OperationModel[] {
  const ordered: OperationModel[] = [];
  let pending = [...models];
  while (pending.length > 0) {
    const waiting = (m: OperationModel) => {
      const trigger = m.operation.trigger;
      return (
        trigger.type === "event" &&
        pending.some((other) => other !== m && other.publishes.has(trigger.event))
      );
    };
    const next = pending.filter((m) => !waiting(m));
    const taken = next.length > 0 ? next : pending.slice(0, 1);
    ordered.push(...taken);
    pending = pending.filter((m) => !taken.includes(m));
  }
  return ordered;
}

/** One spec per (cache component, entity) that some live step looks up. */
export function buildCacheSpecs(
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
  const coalescedBehind = (componentId: string, entity: string) => {
    const reads = ctx.attempt.flows.flatMap((flow) => {
      const live = liveStepIds(flow, ctx.attempt).map((id) => flow.steps[id]);
      const looksUp = live.some(
        (s) => s?.type === "call" && s.action === "cache.get" && s.target === componentId,
      );
      if (!looksUp) return [];
      return live.filter(
        (s): s is Extract<typeof s, { type: "call" }> =>
          s?.type === "call" && s.action === "store.read" && s.entity === entity,
      );
    });
    return reads.length > 0 && reads.every((s) => s.coalesce === true);
  };
  return [...lookups.values()].map(({ componentId, entity }) => {
    const entityBytes = ctx.problem.entities.find((e) => e.name === entity)?.avgBytes ?? 1;
    const memoryGb = profiles.get(componentId)?.memoryGb ?? 0;
    const share = entitiesPerCache.get(componentId) ?? 1;
    const positive = minTtl("cache.set", componentId, entity);
    const negative = minTtl("cache.setNegative", componentId, entity);
    const inProcess = ctx.catalog.kind(
      ctx.attempt.architecture.components.find((c) => c.id === componentId)?.kind ?? "",
    )?.inProcess;
    const caller = ctx.attempt.architecture.connections.find((c) => c.to === componentId)?.from;
    return {
      componentId,
      callerOf: inProcess && caller ? caller : null,
      entity,
      populated: positive.present,
      ttlSec: positive.ttl,
      negativePopulated: negative.present,
      negativeTtlSec: negative.ttl,
      capacityItems: (memoryGb * 1e9 * CACHE_FILL_FACTOR) / entityBytes / share,
      existing: workload.keys[entity]?.existing,
      absent: workload.keys[entity]?.absent,
      coalesced: coalescedBehind(componentId, entity),
    };
  });
}

export interface Occupancy {
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
export function occupancies(workload: Workload, ctx: SimulationContext): Map<string, Occupancy> {
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

/** Gigabytes of entity data each component holds (one copy), from the workload's dataset sizes. */
export function storedGb(workload: Workload, ctx: SimulationContext): Map<string, number> {
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

/**
 * Milliseconds a write to each component waits for its replicas, from the
 * workload's replication decision (asynchronous until the candidate decides).
 * Only self-managed stores with a primary and at least one replica wait.
 */
export function replicaAckMs(workload: Workload, ctx: SimulationContext): Map<string, number> {
  const result = new Map<string, number>();
  const decision = workload.replication?.decision;
  const chosen = decision ? ctx.attempt.decisions[decision] : undefined;
  const mode = REPLICATION_MODES.find((m) => m === chosen) ?? "async";
  if (REPLICA_ACK_MS[mode] === 0) return result;
  for (const component of ctx.attempt.architecture.components) {
    if (waitsForReplicas(component, ctx.catalog)) result.set(component.id, REPLICA_ACK_MS[mode]);
  }
  return result;
}

function waitsForReplicas(component: Component, catalog: CatalogIndex): boolean {
  const kind = catalog.kind(component.kind);
  const managed = catalog.flavor(component.kind, component.flavor)?.managedRedundancy ?? false;
  return (
    !managed &&
    component.replicas >= 2 &&
    (kind?.holdsData ?? false) &&
    kind?.writeScaling === "primaries"
  );
}
