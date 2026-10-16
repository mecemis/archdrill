import {
  type Attempt,
  type CatalogIndex,
  type Component,
  crossZoneBillingOf,
  MAX_ZONES,
} from "@archdrill/model";
import { NETWORK_RTT_MS } from "./calls";
import { SECONDS_PER_MONTH } from "./capacity";
import type { Moments } from "./math/gamma";
import { replicasIn, runsInZones, type Shape, shapeOf } from "./placement";
import type { Load } from "./summary";
import type { ConnectionZoneMetrics } from "./types";

/**
 * Round trip between hosts in one zone: AWS puts it below a millisecond with
 * enhanced networking, and ElastiCache's median of 0.44 ms, service
 * included, bounds it from above.
 */
export const SAME_ZONE_RTT_MS = 0.1;
/**
 * Round trip between zones of a region: AWS counts "1 ms as the minimum
 * network latency added for each AZ traversal" (Improving performance and
 * reducing cost using Availability Zone affinity, AWS Architecture Blog).
 */
export const CROSS_ZONE_RTT_MS = 1;
/**
 * Data crossing zones is billed $0.01 a GB in each direction: the sending
 * end pays for what leaves it and the receiving end for what arrives
 * (Exploring Data Transfer Costs for Classic and Application Load
 * Balancers, AWS, 2023).
 */
export const CROSS_ZONE_USD_PER_GB = 0.01;

/** How the calls over one connection between two components cross zones. */
export interface ZoneRoute {
  /** Share of reads, and of writes, that go to an instance in another zone. */
  readonly crossRead: number;
  readonly crossWrite: number;
  /** The same shares with zone-aware routing, which equal them where it is on. */
  readonly sameZoneCross: { readonly read: number; readonly write: number };
  /** USD for each GB that crosses zones on this hop, both ends together. */
  readonly usdPerGb: number;
}

/**
 * Where a component's instances answer from: its own, or a managed load
 * balancer's nodes in each of its targets' zones.
 */
interface Presence {
  readonly shape: Shape;
  /**
   * Writes go to an instance no routing can choose: a shard's primary, or a
   * partition's leader in a log (consumers may still read from a replica in
   * their zone).
   */
  readonly pinnedWrites: boolean;
}

/**
 * A managed load balancer has a node in each zone it is enabled in, and an
 * Application Load Balancer needs at least two, even for targets in one.
 */
const MIN_BALANCER_ZONES = 2;

/** One node in each of `zones` zones. */
const nodesIn = (zones: number): Shape => ({
  replicas: zones,
  shards: 1,
  managed: true,
  primaries: false,
  writesToPrimaries: false,
  quorum: false,
  zones,
  autoscaled: false,
});

/**
 * Where every component the design places answers from. Clients and
 * in-process components have no hop between zones, and regional services
 * (a managed store, queue or external API) decide for themselves where
 * their endpoints answer: calls to them keep the region's round trip.
 */
function presences(
  attempt: Attempt,
  catalog: CatalogIndex,
  running?: ReadonlyMap<string, number>,
): Map<string, Presence> {
  const result = new Map<string, Presence>();
  const proxies: Component[] = [];
  for (const component of attempt.architecture.components) {
    if (!runsInZones(component, catalog)) continue;
    const flavor = catalog.flavor(component.kind, component.flavor);
    const caps = catalog.capabilities(component.kind, component.flavor);
    if (!flavor?.managedRedundancy) {
      const shape = shapeOf(component, catalog, running?.get(component.id));
      const pinnedWrites = shape.writesToPrimaries || caps.has("async-buffer");
      result.set(component.id, { shape, pinnedWrites });
    } else if (caps.has("load-balancing") || caps.has("routing")) {
      proxies.push(component);
    }
  }
  // A managed proxy's nodes sit in the zones its targets use.
  for (const proxy of proxies) {
    const zones = attempt.architecture.connections
      .filter((c) => c.from === proxy.id)
      .map((c) => result.get(c.to)?.shape.zones ?? 0);
    const spread = Math.max(MIN_BALANCER_ZONES, ...zones);
    result.set(proxy.id, { shape: nodesIn(spread), pinnedWrites: false });
  }
  return result;
}

/** Share of a shard's replicas in each zone. */
function shardShares(shape: Shape, shard: number): number[] {
  return Array.from({ length: MAX_ZONES }, (_, zone) =>
    zone < shape.zones ? replicasIn(zone, shard, shape) / shape.replicas : 0,
  );
}

/** Share of all of a component's instances in each zone: where its calls start. */
function instanceShares(shape: Shape): number[] {
  const shares = new Array<number>(MAX_ZONES).fill(0);
  for (let shard = 0; shard < shape.shards; shard++) {
    shardShares(shape, shard).forEach((share, zone) => {
      shares[zone] = (shares[zone] ?? 0) + share / shape.shards;
    });
  }
  return shares;
}

/** The primary, a shard's first replica, starts one zone further than the shard before. */
function primaryShares(shape: Shape, shard: number): number[] {
  return Array.from({ length: MAX_ZONES }, (_, zone) => (zone === shard % shape.zones ? 1 : 0));
}

/**
 * Share of calls that stay in the caller's zone. Without zone-aware routing
 * a call goes to any of the target's instances; with it, each zone keeps
 * what the target's instances there can take at an even load, and sends the
 * rest elsewhere (Envoy's zone-aware routing works this way).
 */
function stayShare(from: readonly number[], to: readonly number[], aware: boolean): number {
  return from.reduce(
    (sum, share, zone) => sum + (aware ? Math.min(share, to[zone] ?? 0) : share * (to[zone] ?? 0)),
    0,
  );
}

/** Share of calls that cross zones, averaged over the target's shards (keys spread evenly). */
function crossShare(from: readonly number[], to: Presence, write: boolean, aware: boolean): number {
  const { shape } = to;
  // A write goes to its shard's primary or its partition's leader, which no routing can move.
  const pinned = write && to.pinnedWrites;
  let stay = 0;
  for (let shard = 0; shard < shape.shards; shard++) {
    const target =
      pinned && shape.writesToPrimaries ? primaryShares(shape, shard) : shardShares(shape, shard);
    stay += stayShare(from, target, aware && !pinned);
  }
  return Math.max(0, 1 - stay / shape.shards);
}

/** What one end adds to a hop's price per GB crossing zones; null when the hop is free. */
function endPrice(component: Component, catalog: CatalogIndex): number | null {
  const flavor = catalog.flavor(component.kind, component.flavor);
  const billing = flavor ? crossZoneBillingOf(flavor) : "each-end";
  if (billing === "free") return null;
  return billing === "each-end" ? CROSS_ZONE_USD_PER_GB : 0;
}

/**
 * How each connection between two components the design places crosses
 * zones. Hops from clients start outside the region, in-process components
 * have no network hop, and regional services answer where they choose, so
 * none of them has a route. `running` gives the instances autoscaled
 * components run, where known.
 */
export function zoneRoutes(
  attempt: Attempt,
  catalog: CatalogIndex,
  running?: ReadonlyMap<string, number>,
): Map<string, ZoneRoute> {
  const byId = new Map(attempt.architecture.components.map((c) => [c.id, c]));
  const placed = presences(attempt, catalog, running);
  const routes = new Map<string, ZoneRoute>();
  for (const connection of attempt.architecture.connections) {
    const from = byId.get(connection.from);
    const to = byId.get(connection.to);
    const caller = placed.get(connection.from);
    const target = placed.get(connection.to);
    if (!from || !to || !caller || !target) continue;
    const prices = [endPrice(from, catalog), endPrice(to, catalog)];
    const usdPerGb = prices.includes(null)
      ? 0
      : prices.reduce<number>((sum, price) => sum + (price ?? 0), 0);
    const shares = instanceShares(caller.shape);
    const sameZoneCross = {
      read: crossShare(shares, target, false, true),
      write: crossShare(shares, target, true, true),
    };
    const aware = connection.policy.sameZone;
    routes.set(connection.id, {
      crossRead: aware ? sameZoneCross.read : crossShare(shares, target, false, false),
      crossWrite: aware ? sameZoneCross.write : crossShare(shares, target, true, false),
      sameZoneCross,
      usdPerGb,
    });
  }
  return routes;
}

/** Mean round trip of a call over a route, within a zone or across. */
export function hopRoundTripMs(route: ZoneRoute, write: boolean): number {
  const cross = write ? route.crossWrite : route.crossRead;
  return SAME_ZONE_RTT_MS + cross * (CROSS_ZONE_RTT_MS - SAME_ZONE_RTT_MS);
}

/**
 * Round trip a write waits for to reach its replicas: the nearest one when
 * one acknowledgement is enough (semi-synchronous), the farthest when all
 * must answer (synchronous). Averaged over shards; 0 without replicas.
 */
export function replicaRoundTripMs(
  component: Component,
  catalog: CatalogIndex,
  waitFor: "semi-sync" | "sync",
): number {
  const shape = shapeOf(component, catalog);
  if (shape.replicas < 2) return 0;
  let total = 0;
  for (let shard = 0; shard < shape.shards; shard++) {
    // Replica i of a shard sits i zones after its primary.
    const trips = Array.from({ length: shape.replicas - 1 }, (_, i) =>
      (i + 1) % shape.zones === 0 ? SAME_ZONE_RTT_MS : CROSS_ZONE_RTT_MS,
    );
    total += waitFor === "semi-sync" ? Math.min(...trips) : Math.max(...trips);
  }
  return total / shape.shards;
}

/** A network round trip: little spread around its mean. */
export function networkHop(roundTripMs: number): Moments {
  return { mean: roundTripMs, variance: (0.2 * roundTripMs) ** 2 };
}

/** A hop the design does not place in zones: a client's on its way in, or one to a regional service. */
export const NETWORK_HOP: Moments = networkHop(NETWORK_RTT_MS);

/** Round trips of reads and of writes over one connection. */
export interface RouteHops {
  readonly read: Moments;
  readonly write: Moments;
}

export function routeHops(routes: ReadonlyMap<string, ZoneRoute>): Map<string, RouteHops> {
  return new Map(
    [...routes].map(([id, route]) => [
      id,
      {
        read: networkHop(hopRoundTripMs(route, false)),
        write: networkHop(hopRoundTripMs(route, true)),
      },
    ]),
  );
}

/** The round trip of a call over a connection; a client's hop where it has no route. */
export function hopOver(
  hops: ReadonlyMap<string, RouteHops>,
  connectionId: string | null | undefined,
  write: boolean,
): Moments {
  const hop = connectionId == null ? undefined : hops.get(connectionId);
  if (!hop) return NETWORK_HOP;
  return write ? hop.write : hop.read;
}

const BYTES_PER_GB = 1e9;

/** What crosses zones over each routed connection, and what it costs a month. */
export function summarizeZoneTraffic(
  transfer: ReadonlyMap<string, Load>,
  routes: ReadonlyMap<string, ZoneRoute>,
): Map<string, ConnectionZoneMetrics> {
  const result = new Map<string, ConnectionZoneMetrics>();
  for (const [connectionId, route] of routes) {
    const bytes = transfer.get(connectionId) ?? { read: 0, write: 0 };
    const gbPerMonth = (read: number, write: number) =>
      ((bytes.read * read + bytes.write * write) * SECONDS_PER_MONTH) / BYTES_PER_GB;
    const crossGbPerMonth = gbPerMonth(route.crossRead, route.crossWrite);
    const sameZoneGb = gbPerMonth(route.sameZoneCross.read, route.sameZoneCross.write);
    result.set(connectionId, {
      connectionId,
      crossRead: route.crossRead,
      crossWrite: route.crossWrite,
      roundTripMs: { read: hopRoundTripMs(route, false), write: hopRoundTripMs(route, true) },
      bytesPerSec: { read: bytes.read, write: bytes.write },
      crossGbPerMonth,
      usdPerGb: route.usdPerGb,
      monthlyCost: crossGbPerMonth * route.usdPerGb,
      avoidableMonthlyCost: Math.max(0, crossGbPerMonth - sameZoneGb) * route.usdPerGb,
    });
  }
  return result;
}

/**
 * Cross-zone traffic billed to each component: a connection's goes to the
 * component that makes the calls, for both ends' share.
 */
export function crossZoneCostByCaller(
  traffic: ReadonlyMap<string, ConnectionZoneMetrics>,
  attempt: Attempt,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const connection of attempt.architecture.connections) {
    const cost = traffic.get(connection.id)?.monthlyCost ?? 0;
    if (cost > 0) result.set(connection.from, (result.get(connection.from) ?? 0) + cost);
  }
  return result;
}
