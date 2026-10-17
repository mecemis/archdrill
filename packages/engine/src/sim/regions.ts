import {
  ACTIONS,
  type Attempt,
  type CatalogIndex,
  type Component,
  runsInRegion,
  type Workload,
} from "@archdrill/model";
import type { CallPathStep } from "../paths/types";
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
/** Round trip between us-east-1 and us-west-2, as third-party measurements give it. */
export const CROSS_REGION_RTT_MS = 68;

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
export type RegionPhase = "redirecting" | "half-redirecting" | "promoting";

/**
 * Whether the component is a way into the region: clients call it, and
 * nothing else in the region does. A component that both clients and
 * another way in call fails only once for a request, at the first.
 */
export function takesClients(
  component: Component,
  attempt: Attempt,
  catalog: CatalogIndex,
): boolean {
  const callers = attempt.architecture.connections
    .filter((c) => c.to === component.id)
    .map((c) => attempt.architecture.components.find((x) => x.id === c.from))
    .filter((c): c is Component => c !== undefined);
  const fromClients = callers.some((c) =>
    catalog.capabilities(c.kind, c.flavor).has("traffic-source"),
  );
  return fromClients && !callers.some((c) => inRegion(c, catalog));
}

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
  /** Both regions take traffic: a placed copy is billed with its instances already. */
  active = false,
): Map<string, number> {
  const written = new Map<string, number>();
  for (const connection of attempt.architecture.connections) {
    const bytes = flow.transfer.get(connection.id)?.write ?? 0;
    written.set(connection.to, (written.get(connection.to) ?? 0) + bytes);
  }
  const result = new Map<string, number>();
  for (const component of attempt.architecture.components) {
    if (!hasStandby(component, catalog)) continue;
    const cost = standbyCost(component, catalog, active, {
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
  active: boolean,
  use: { readonly storedGb: number; readonly writes: number; readonly writtenBytesPerSec: number },
): number {
  const kind = catalog.kind(component.kind);
  const flavor = catalog.flavor(component.kind, component.flavor);
  const size = flavor?.sizes[component.size ?? flavor.defaultSize ?? ""];
  if (!kind || !flavor || !size) return 0;
  // The standby copy is placed like the primary one, at its minimum instances;
  // while it takes traffic, its instances and their copies of the data are
  // billed as the component's own.
  const placed = kind.replicable && !flavor.managedRedundancy;
  const billedAlready = active && placed;
  const replicas = placed ? component.replicas : 1;
  const shards = kind.shardable ? component.shards : 1;
  const instances = billedAlready ? 0 : size.costPerHour * replicas * shards * HOURS_PER_MONTH;
  const storage = billedAlready
    ? 0
    : use.storedGb * replicas * (flavor.storagePricePerGbMonth ?? 0);
  // A managed store applies every write in both regions, and bills each.
  const writes = kind.holdsData
    ? (use.writes * (flavor.requestCost?.writePerMillion ?? 0) * SECONDS_PER_MONTH) / 1e6
    : 0;
  // Stores replicate; a cache is kept filled across regions only for a standby that waits.
  const replicated = kind.holdsData || (flavor.crossRegionReplication === true && !active);
  const transfer = replicated
    ? ((use.writtenBytesPerSec * SECONDS_PER_MONTH) / BYTES_PER_GB) * CROSS_REGION_USD_PER_GB
    : 0;
  return instances + storage + writes + transfer;
}

/** Whether the design has decided that both regions take traffic (active-active). */
export function activeActive(workload: Workload, attempt: Attempt): boolean {
  const decision = workload.regionMode?.decision;
  return decision !== undefined && attempt.decisions[decision] === "active-active";
}

/**
 * The design while both regions take traffic: a component with a standby
 * copy runs both, so a fleet has twice the instances (and twice the
 * autoscaling range) and a store twice the replicas serving reads. A store
 * with a primary keeps one primary per shard, so its writes do not double.
 */
export function withActiveStandby(attempt: Attempt, catalog: CatalogIndex): Attempt {
  return {
    ...attempt,
    architecture: {
      ...attempt.architecture,
      components: attempt.architecture.components.map((c) => {
        const kind = catalog.kind(c.kind);
        const managed = catalog.flavor(c.kind, c.flavor)?.managedRedundancy ?? false;
        if (!hasStandby(c, catalog) || !kind?.replicable || managed) return c;
        return {
          ...c,
          replicas: c.replicas * 2,
          ...(c.autoscale && { autoscale: { ...c.autoscale, max: c.autoscale.max * 2 } }),
        };
      }),
    },
  };
}

/**
 * A store that takes writes in one region only, at its primary: its writes
 * from the other region cross. Caches are left out: while both regions take
 * traffic, each region's cache is filled by its own.
 */
export function singleWriter(component: Component, catalog: CatalogIndex): boolean {
  const kind = catalog.kind(component.kind);
  const flavor = catalog.flavor(component.kind, component.flavor);
  // The catalog's managed stores (DynamoDB) take writes in every region; a
  // managed store with one writer (an Aurora global database) would need a flag.
  if (!kind || !flavor || flavor.managedRedundancy) return false;
  return kind.holdsData && kind.writeScaling === "primaries" && !kind.quorum;
}

/**
 * Share of a call's requests that cross regions while both take traffic:
 * half of every call a two-region caller makes to a component in the
 * primary region only, or to a single writer's primary (writes, consistent
 * reads, and calls sent to the home region).
 */
export function crossRegionShare(
  step: CallPathStep,
  attempt: Attempt,
  catalog: CatalogIndex,
): number {
  const connection = attempt.architecture.connections.find((c) => c.id === step.connectionId);
  const caller = attempt.architecture.components.find((c) => c.id === connection?.from);
  const target = attempt.architecture.components.find((c) => c.id === step.target);
  if (!caller || !target || !hasStandby(caller, catalog) || !inRegion(target, catalog)) return 0;
  if (!hasStandby(target, catalog) || step.homeRegion) return 0.5;
  const write = ACTIONS[step.action].effect !== "read";
  return singleWriter(target, catalog) && (write || step.consistent) ? 0.5 : 0;
}
