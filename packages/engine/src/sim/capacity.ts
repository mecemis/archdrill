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
  /** Its callers reach it through pools, one statement per connection. */
  readonly pooledConnections: boolean;
  /** Mean service time per request, milliseconds. */
  readonly serviceTimeMs: number;
  /** Coefficient of variation of the service time. */
  readonly cv: number;
  /** Concurrent requests the component can work on (capacity × service time, Little's law). */
  readonly servers: number;
  readonly memoryGb: number;
  readonly costPerHour: number;
  /** What the connection proxy in front of it costs an hour; 0 without one. */
  readonly proxyCostPerHour: number;
  readonly requestCost: {
    readonly readPerMillion: number;
    readonly writePerMillion: number;
  } | null;
  /** Capacity units billed by connections and bytes (a managed load balancer's), or null. */
  readonly capacityUnits: Flavor["capacityUnits"] | null;
  /** Full copies of the stored data: each replica of a shard holds that shard's data. */
  readonly storageCopies: number;
  readonly storagePricePerGbMonth: number;
  /** Gigabytes billed at least, across its shards (one copy): provisioning I/Os takes a striped volume. */
  readonly minStoredGb: number;
  /** What the I/Os provisioned above the volume's own cost a month, every copy. */
  readonly provisionedIopsCostPerMonth: number;
  /** For a store that reads pages from a volume: what its reads and writes take of it. */
  readonly storage: StorageProfile | null;
}

/** A store's volume, and what its reads and writes take of it. */
export interface StorageProfile {
  /** Volume I/Os a read takes on average: the pages of the reads its page cache misses. */
  readonly ioPerRead: number;
  /** Volume I/Os a write takes: the pages it dirties, on every copy of its shard. */
  readonly ioPerWrite: number;
  /** I/Os a second one copy sustains: its volume's, or its instance's if fewer. */
  readonly iopsPerCopy: number;
  /** The same for every copy together. */
  readonly iopsCapacity: number;
  /** Milliseconds one page read takes from an idle volume. */
  readonly readMs: number;
  /** Pages a read that misses reads. */
  readonly pagesPerRead: number;
  /** Share of its reads of ordinary keys the page cache answers. */
  readonly hitRatio: number;
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
    pooledConnections: kind.pooledConnections,
    serviceTimeMs,
    cv: size.latencyMs.cv,
    servers,
    memoryGb: (size.memoryGb ?? 0) * shards,
    costPerHour: size.costPerHour * instances,
    // Billed per vCPU of every instance behind it.
    proxyCostPerHour:
      component.proxy && flavor.connectionProxy && size.vcpus
        ? flavor.connectionProxy.pricePerVcpuHour * size.vcpus * instances
        : 0,
    requestCost: flavor.requestCost ?? null,
    capacityUnits: flavor.capacityUnits ?? null,
    storageCopies: replicas,
    storagePricePerGbMonth: flavor.storagePricePerGbMonth ?? 0,
    ...provisionedVolume(component, flavor, shards, instances),
    storage: null,
  };
}

/** I/Os a second a store's copy has: provisioned within the volume's range, else what its size gives. */
export function volumeIops(
  volume: NonNullable<Flavor["storageVolume"]>,
  provisioned: number | undefined,
  copyGb: number,
): number {
  if (provisioned !== undefined) {
    return Math.min(volume.maxIops, Math.max(volume.stripedIops, provisioned));
  }
  return copyGb >= volume.stripedFromGb ? volume.stripedIops : volume.baselineIops;
}

/**
 * Provisioned I/Os are billed above what the striped volume includes, on
 * every copy; provisioning takes a striped volume, so at least its size.
 */
function provisionedVolume(
  component: Component,
  flavor: Flavor,
  shards: number,
  instances: number,
): { minStoredGb: number; provisionedIopsCostPerMonth: number } {
  const volume = flavor.storageVolume;
  if (!volume || component.iops === undefined) {
    return { minStoredGb: 0, provisionedIopsCostPerMonth: 0 };
  }
  const extra = volumeIops(volume, component.iops, volume.stripedFromGb) - volume.stripedIops;
  return {
    minStoredGb: volume.stripedFromGb * shards,
    provisionedIopsCostPerMonth: extra * volume.pricePerIopsMonth * instances,
  };
}
