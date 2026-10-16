import { type CatalogIndex, type Component, placedInZones } from "@archdrill/model";

/*
 * Where a component's instances run: how many hold each shard, and how they
 * are dealt over the zones. A lost zone and traffic between zones both
 * follow from it.
 */

/** Whether a component has instances in the region's zones: not a client, nor in-process. */
export function runsInZones(component: Component, catalog: CatalogIndex): boolean {
  return (
    !catalog.kind(component.kind)?.inProcess &&
    !catalog.capabilities(component.kind, component.flavor).has("traffic-source")
  );
}

export interface Shape {
  /** Instances that each hold a full copy of one shard (1 for managed or non-replicable kinds). */
  readonly replicas: number;
  readonly shards: number;
  /** The provider replaces failed nodes and fails over without the design's help. */
  readonly managed: boolean;
  /** A store whose writes go to one primary per shard, which a failover has to replace. */
  readonly primaries: boolean;
  /** Writes scale with primaries only, so a lost replica costs no write capacity. */
  readonly writesToPrimaries: boolean;
  /** A shard stops once half of its replicas are lost. */
  readonly quorum: boolean;
  /** Zones its instances are spread over (1 where the design does not place them). */
  readonly zones: number;
  /**
   * Instances follow the load and how many run is not known, so a zone holds
   * its even share of them.
   */
  readonly autoscaled: boolean;
}

export function shapeOf(component: Component, catalog: CatalogIndex, running?: number): Shape {
  const kind = catalog.kind(component.kind);
  const flavor = catalog.flavor(component.kind, component.flavor);
  const managed = flavor?.managedRedundancy ?? false;
  const replicas = kind?.replicable && !managed ? (running ?? component.replicas) : 1;
  const shards = kind?.shardable ? component.shards : 1;
  const placed = kind !== undefined && flavor !== undefined && placedInZones(kind, flavor);
  return {
    replicas,
    shards,
    managed,
    // Quorum stores (Cassandra) write to a majority of replicas, with no primary to replace.
    primaries: (kind?.holdsData ?? false) && kind?.writeScaling === "primaries" && !kind.quorum,
    writesToPrimaries: kind?.writeScaling === "primaries",
    quorum: kind?.quorum ?? false,
    zones: placed ? Math.max(1, Math.min(component.zones, replicas * shards)) : 1,
    autoscaled: component.autoscale !== undefined && running === undefined,
  };
}

/**
 * Instances of one shard in a zone. Each shard's replicas are dealt over the
 * zones in turn, starting one zone further than the shard before, as
 * providers balance them: a shard's replicas land in different zones first,
 * its first one (the primary) moves round the zones from shard to shard,
 * and the zones hold as many instances as each other, give or take one.
 */
export function replicasIn(zone: number, shard: number, shape: Shape): number {
  const first = (((zone - shard) % shape.zones) + shape.zones) % shape.zones;
  return first < shape.replicas ? Math.floor((shape.replicas - 1 - first) / shape.zones) + 1 : 0;
}

/** Shards whose primary, each shard's first replica, sits in the zone. */
export function primariesIn(zone: number, shape: Shape): number {
  return Math.floor((shape.shards - 1 - zone) / shape.zones) + 1;
}
