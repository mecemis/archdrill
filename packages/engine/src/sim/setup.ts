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
};

export interface SimulationContext {
  readonly attempt: Attempt;
  readonly catalog: CatalogIndex;
  readonly problem: Problem;
  readonly analysis: Analysis;
}

export interface OperationModel {
  readonly operation: Operation;
  readonly rate: number;
  readonly analysis: OperationAnalysis;
  readonly classes: readonly RequestClass[];
  /** Ingress components that do work (the client is excluded), in order. */
  readonly ingress: readonly string[];
}

export interface CacheSpec {
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

export const cacheKey = (componentId: string, entity: string | undefined) =>
  `${componentId}|${entity ?? ""}`;

/** Capacity and latency of every component that does work, under the environment's faults. */
export function buildProfiles(
  ctx: SimulationContext,
  faults: ReadonlyMap<string, ComponentFault>,
): Map<string, ComponentProfile> {
  const profiles = new Map<string, ComponentProfile>();
  for (const component of ctx.attempt.architecture.components) {
    const profile = componentProfile(component, ctx.catalog);
    if (profile)
      profiles.set(component.id, faultedProfile(profile, faults.get(component.id) ?? NO_FAULT));
  }
  return profiles;
}

export function buildOperations(
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
