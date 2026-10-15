import type { CatalogIndex, Component, Flavor } from "@archdrill/model";

export const HOURS_PER_MONTH = 730;
/** Bytes a second in one gigabit a second. */
export const BYTES_PER_GBIT = 1e9 / 8;
export const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600;
/** Concurrency cap for the queueing model when capacity is effectively unbounded. */
const MAX_SERVERS = 1_000_000;

/** What one component can do, derived from its catalog size and counts. */
export interface ComponentProfile {
  readonly instances: number;
  /** Shards the keys are split over (1 for kinds that are not sharded). */
  readonly shards: number;
  /** Keys map to shards, so one hot key loads one shard. */
  readonly sharded: boolean;
  /** Runs inside its caller: no network hop, one copy per caller instance. */
  readonly inProcess: boolean;
  readonly readCapacity: number;
  readonly writeCapacity: number;
  /** Bytes a second its reads can return over the network, every instance's baseline (infinite when unlimited). */
  readonly outboundBytesPerSec: number;
  /** Writes a second one key can take, wherever it lives (infinite when only capacity limits it). */
  readonly perKeyWriteCapacity: number;
  /** Client connections the component can hold open (infinite for components that hold none). */
  readonly connectionCapacity: number;
  /** Client connections it holds in this environment. */
  readonly heldConnections: number;
  /** Mean service time per request, milliseconds. */
  readonly serviceTimeMs: number;
  /** Coefficient of variation of the service time. */
  readonly cv: number;
  /** Concurrent requests the component can work on (capacity × service time, Little's law). */
  readonly servers: number;
  readonly memoryGb: number;
  readonly costPerHour: number;
  readonly requestCost: {
    readonly readPerMillion: number;
    readonly writePerMillion: number;
  } | null;
  /** Capacity units billed by connections and bytes (a managed load balancer's), or null. */
  readonly capacityUnits: Flavor["capacityUnits"] | null;
  /** Full copies of the stored data: each replica of a shard holds that shard's data. */
  readonly storageCopies: number;
  readonly storagePricePerGbMonth: number;
}

/**
 * Capacity, latency and cost of a component. Replicas add read capacity; for
 * stores whose writes go to primaries only, write capacity scales with shards.
 * Managed, zone-redundant offerings count as one billable unit.
 * Returns null for components that do no work (traffic sources).
 */
export function componentProfile(
  component: Component,
  catalog: CatalogIndex,
  /** Replicas to assume instead of the component's own, e.g. after autoscaling. */
  scaledReplicas?: number,
): ComponentProfile | null {
  const kind = catalog.kind(component.kind);
  const flavor = catalog.flavor(component.kind, component.flavor);
  if (!kind || !flavor) return null;
  const size = flavor.sizes[component.size ?? flavor.defaultSize ?? ""];
  if (!size) return null;
  const managed = flavor.managedRedundancy;
  const replicas = managed || !kind.replicable ? 1 : (scaledReplicas ?? component.replicas);
  const shards = kind.shardable ? component.shards : 1;
  const instances = shards * replicas;
  const readCapacity = (size.capacityPerSec.read ?? Number.POSITIVE_INFINITY) * instances;
  const writers = kind.writeScaling === "primaries" ? shards : instances;
  const writeCapacity = (size.capacityPerSec.write ?? Number.POSITIVE_INFINITY) * writers;
  const serviceTimeMs = size.latencyMs.base;
  const servers = Number.isFinite(readCapacity)
    ? Math.max(1, Math.min(MAX_SERVERS, Math.round((readCapacity * serviceTimeMs) / 1000)))
    : MAX_SERVERS;
  return {
    instances,
    shards,
    sharded: kind.shardable,
    inProcess: kind.inProcess,
    readCapacity,
    writeCapacity,
    // Every instance serves reads, so every instance's outbound bandwidth carries their values.
    outboundBytesPerSec:
      size.networkGbps === undefined
        ? Number.POSITIVE_INFINITY
        : size.networkGbps * BYTES_PER_GBIT * instances,
    perKeyWriteCapacity: flavor.perKeyCapacityPerSec?.write ?? Number.POSITIVE_INFINITY,
    connectionCapacity:
      size.maxConnections === undefined ? Number.POSITIVE_INFINITY : size.maxConnections * replicas,
    heldConnections: 0,
    serviceTimeMs,
    cv: size.latencyMs.cv,
    servers,
    memoryGb: (size.memoryGb ?? 0) * shards,
    costPerHour: size.costPerHour * instances,
    requestCost: flavor.requestCost ?? null,
    capacityUnits: flavor.capacityUnits ?? null,
    storageCopies: replicas,
    storagePricePerGbMonth: flavor.storagePricePerGbMonth ?? 0,
  };
}
