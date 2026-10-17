import { type Attempt, type CatalogIndex, type Component, runsInRegion } from "@archdrill/model";
import { HOURS_PER_MONTH, SECONDS_PER_MONTH } from "./capacity";
import type { Load } from "./summary";

/*
 * A design runs in its primary region. Components with `regions: 2` keep a
 * standby copy in a second region that takes no traffic until the primary
 * region is lost (active-passive): DNS then sends clients to the standby
 * region, its stores are promoted, and its fleets scale up from their
 * minimum (ADR 0016).
 */

/** Route 53 checks an endpoint every 30 s and calls it unhealthy after three failed checks. */
export const HEALTH_CHECK_DETECTION_SEC = 90;
/** Resolvers keep a load balancer's DNS answer for its TTL of 60 s. */
export const DNS_TTL_SEC = 60;
/** Seconds from losing the primary region until clients reach the standby region. */
export const REGION_DNS_FAILOVER_SEC = HEALTH_CHECK_DETECTION_SEC + DNS_TTL_SEC;
/** USD per GB replicated to the standby region: us-east-1 to us-west-2, billed at the sender. */
export const CROSS_REGION_USD_PER_GB = 0.02;

const BYTES_PER_GB = 1e9;

/** Whether losing the design's region takes the component: not a client, nor external, nor in-process. */
export function inRegion(component: Component, catalog: CatalogIndex): boolean {
  const kind = catalog.kind(component.kind);
  const flavor = catalog.flavor(component.kind, component.flavor);
  return kind !== undefined && flavor !== undefined && runsInRegion(kind, flavor);
}

/** Whether the component keeps a copy in the standby region. */
export function hasStandby(component: Component, catalog: CatalogIndex): boolean {
  return component.regions > 1 && inRegion(component, catalog);
}

/**
 * Seconds after the primary region is lost until the standby copy takes
 * writes: once clients arrive for most components, and for a store whose
 * writes go to a primary, once its copy has been promoted. Promotion starts
 * when the health checks declare the region lost.
 */
export function standbyWritesAt(component: Component, catalog: CatalogIndex): number {
  const promotion = catalog.flavor(component.kind, component.flavor)?.regionFailoverSec;
  if (promotion === undefined) return REGION_DNS_FAILOVER_SEC;
  return Math.max(REGION_DNS_FAILOVER_SEC, HEALTH_CHECK_DETECTION_SEC + promotion);
}

/**
 * A standby cache that is not kept filled starts empty when traffic
 * arrives, and so does an in-process cache in a standby service: the
 * standby instances never served a request.
 */
export function standbyStartsCold(
  component: Component,
  attempt: Attempt,
  catalog: CatalogIndex,
): boolean {
  if (!catalog.capabilities(component.kind, component.flavor).has("volatile-kv")) return false;
  if (catalog.kind(component.kind)?.inProcess) {
    const hosts = attempt.architecture.connections.filter((c) => c.to === component.id);
    return hosts.some((c) => {
      const host = attempt.architecture.components.find((h) => h.id === c.from);
      return host !== undefined && hasStandby(host, catalog);
    });
  }
  if (!hasStandby(component, catalog)) return false;
  return catalog.flavor(component.kind, component.flavor)?.crossRegionReplication !== true;
}

/**
 * Where losing the primary region leaves a component on the way to the
 * standby region: clients still sent to the lost region, or a store's copy
 * still being promoted. Without a phase, the failover has settled.
 */
export type RegionPhase = "redirecting" | "promoting";

/**
 * What losing the primary region does to a component once the failover has
 * settled: whether it keeps serving, and why not.
 */
export function regionLoss(
  component: Component,
  catalog: CatalogIndex,
): { readonly keepsServing: boolean; readonly label: string } {
  if (!inRegion(component, catalog)) {
    return { keepsServing: true, label: "not in the design's region" };
  }
  if (hasStandby(component, catalog)) {
    return { keepsServing: true, label: "taken over by its standby copy" };
  }
  return { keepsServing: false, label: "runs only in the primary region" };
}

/**
 * What the standby copies cost a month: their instances (the minimum of an
 * autoscaled fleet), their copy of the stored data, the writes a managed
 * store applies in both regions, and the data replicated to them.
 * `transfer` gives the bytes a second sent over each connection, and
 * `batchedItems` the items batched calls carry beyond one per call, which a
 * store billed per item pays for.
 */
export function standbyCosts(
  attempt: Attempt,
  catalog: CatalogIndex,
  stored: ReadonlyMap<string, number>,
  flow: {
    readonly loads: ReadonlyMap<string, Load>;
    readonly batchedItems: ReadonlyMap<string, Load>;
    readonly transfer: ReadonlyMap<string, Load>;
  },
): Map<string, number> {
  const written = new Map<string, number>();
  for (const connection of attempt.architecture.connections) {
    const bytes = flow.transfer.get(connection.id)?.write ?? 0;
    written.set(connection.to, (written.get(connection.to) ?? 0) + bytes);
  }
  const result = new Map<string, number>();
  for (const component of attempt.architecture.components) {
    if (!hasStandby(component, catalog)) continue;
    const cost = standbyCost(component, catalog, {
      storedGb: stored.get(component.id) ?? 0,
      writes:
        (flow.loads.get(component.id)?.write ?? 0) +
        (flow.batchedItems.get(component.id)?.write ?? 0),
      writtenBytesPerSec: written.get(component.id) ?? 0,
    });
    if (cost > 0) result.set(component.id, cost);
  }
  return result;
}

function standbyCost(
  component: Component,
  catalog: CatalogIndex,
  use: { readonly storedGb: number; readonly writes: number; readonly writtenBytesPerSec: number },
): number {
  const kind = catalog.kind(component.kind);
  const flavor = catalog.flavor(component.kind, component.flavor);
  const size = flavor?.sizes[component.size ?? flavor.defaultSize ?? ""];
  if (!kind || !flavor || !size) return 0;
  // The standby copy is placed like the primary one, at its minimum instances.
  const replicas = kind.replicable && !flavor.managedRedundancy ? component.replicas : 1;
  const shards = kind.shardable ? component.shards : 1;
  const instances = size.costPerHour * replicas * shards * HOURS_PER_MONTH;
  const storage = use.storedGb * replicas * (flavor.storagePricePerGbMonth ?? 0);
  // A managed store applies every write in both regions, and bills each.
  const writes = kind.holdsData
    ? (use.writes * (flavor.requestCost?.writePerMillion ?? 0) * SECONDS_PER_MONTH) / 1e6
    : 0;
  const replicated = kind.holdsData || flavor.crossRegionReplication === true;
  const transfer = replicated
    ? ((use.writtenBytesPerSec * SECONDS_PER_MONTH) / BYTES_PER_GB) * CROSS_REGION_USD_PER_GB
    : 0;
  return instances + storage + writes + transfer;
}
