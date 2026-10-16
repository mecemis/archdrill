import type { Attempt, CatalogIndex, Component, ComponentSelector, Fault } from "@archdrill/model";
import type { ComponentProfile } from "./capacity";
import { primariesIn, replicasIn, runsInZones, type Shape, shapeOf } from "./placement";

/** The combined effect of an environment's faults on one component. */
export interface ComponentFault {
  /** Share of calls that fail because of the fault, for calls that read and that change data. */
  readonly failRead: number;
  readonly failWrite: number;
  /** Failed calls hang until the caller gives up, instead of being refused at once. */
  readonly hang: boolean;
  /**
   * Multipliers on read and write capacity: lost nodes or degradation. They
   * differ for stores whose writes go to primaries, where losing a replica
   * costs reads only.
   */
  readonly readCapacity: number;
  readonly writeCapacity: number;
  /** Multiplier on service time; capacity divides by it too. */
  readonly slowFactor: number;
  /** What happened, for people: "down", "one node down (survived by replicas)". */
  readonly labels: readonly string[];
}

export const NO_FAULT: ComponentFault = {
  failRead: 0,
  failWrite: 0,
  hang: false,
  readCapacity: 1,
  writeCapacity: 1,
  slowFactor: 1,
  labels: [],
};

/**
 * Components a selector picks: all fields must match. In-process components
 * live and die with their service, so only a selector naming their kind
 * picks them on their own.
 */
export function selectComponents(
  selector: ComponentSelector,
  attempt: Attempt,
  catalog: CatalogIndex,
): Component[] {
  return attempt.architecture.components.filter((c) => {
    if (selector.kind && c.kind !== selector.kind) return false;
    if (!selector.kind && catalog.kind(c.kind)?.inProcess) return false;
    if (selector.capability && !catalog.capabilities(c.kind, c.flavor).has(selector.capability))
      return false;
    if (selector.holds && !c.data.some((d) => d.entity === selector.holds)) return false;
    if (selector.handlerOf) {
      const flow = attempt.flows.find((f) => f.operation === selector.handlerOf);
      if (flow?.handler !== c.id) return false;
    }
    return true;
  });
}

/**
 * Components a fault hits: those its selector picks, or for a lost zone every
 * component with instances of its own on the network. Clients are outside
 * the region, and in-process components fail with their service's instances.
 */
export function faultedComponents(
  fault: Fault,
  attempt: Attempt,
  catalog: CatalogIndex,
): Component[] {
  if (fault.kind !== "zone-down") return selectComponents(fault.target, attempt, catalog);
  return attempt.architecture.components.filter((c) => runsInZones(c, catalog));
}

/**
 * Per component, the combined effect of every fault in the environment.
 * `running` gives the instances autoscaled components run, where known.
 */
export function resolveFaults(
  faults: readonly Fault[],
  attempt: Attempt,
  catalog: CatalogIndex,
  running?: ReadonlyMap<string, number>,
): Map<string, ComponentFault> {
  const hits = faults.flatMap((fault) =>
    faultedComponents(fault, attempt, catalog).map((component) => ({ fault, component })),
  );
  return resolveFaultHits(hits, catalog, running);
}

/** One fault on one component; a lost zone may still be failing over its primaries. */
export interface FaultHit {
  readonly fault: Fault;
  readonly component: Component;
  readonly failingOver?: boolean;
}

/** Per component, the combined effect of the faults that hit it. */
export function resolveFaultHits(
  hits: readonly FaultHit[],
  catalog: CatalogIndex,
  running?: ReadonlyMap<string, number>,
): Map<string, ComponentFault> {
  const result = new Map<string, ComponentFault>();
  for (const { fault, component, failingOver } of hits) {
    const shape = shapeOf(component, catalog, running?.get(component.id));
    const effect = faultEffect(fault, shape, failingOver ?? false);
    result.set(component.id, combine(result.get(component.id) ?? NO_FAULT, effect));
  }
  return result;
}

/**
 * Seconds until a replica has taken over a lost primary: the catalog's
 * figure for a store whose writes go to a primary, 0 when there is none to
 * replace or the provider fails over unseen, and undefined when no replica
 * can take over or the catalog does not say.
 */
export function failoverSecOf(component: Component, catalog: CatalogIndex): number | undefined {
  const shape = shapeOf(component, catalog);
  if (shape.managed || !shape.primaries) return 0;
  if (shape.replicas < 2) return undefined;
  return catalog.flavor(component.kind, component.flavor)?.failoverSec;
}

/** Whether losing a zone makes the store fail over: a primary was there, and its shard survives. */
export function failsOverWithZone(component: Component, catalog: CatalogIndex): boolean {
  if (!runsInZones(component, catalog)) return false;
  const shape = shapeOf(component, catalog);
  const settled = zoneDown(shape, false, "down");
  return zoneDown(shape, false, "down", true).failWrite > settled.failWrite;
}

/**
 * Two faults on one component: failed shares are assumed to hit the same part
 * (a lost shard that also fails over), so the larger one wins; capacity
 * losses compound. If either fault hangs, failed calls hang.
 */
function combine(a: ComponentFault, b: ComponentFault): ComponentFault {
  return {
    failRead: Math.max(a.failRead, b.failRead),
    failWrite: Math.max(a.failWrite, b.failWrite),
    hang: a.hang || b.hang,
    readCapacity: a.readCapacity * b.readCapacity,
    writeCapacity: a.writeCapacity * b.writeCapacity,
    slowFactor: a.slowFactor * b.slowFactor,
    labels: [...a.labels, ...b.labels],
  };
}

const fail = (share: number, hang: boolean, labels: string[]): ComponentFault => ({
  ...NO_FAULT,
  failRead: share,
  failWrite: share,
  hang,
  labels,
});

function faultEffect(fault: Fault, shape: Shape, failingOver: boolean): ComponentFault {
  const hangs = "mode" in fault && fault.mode === "hang";
  const how = hangs ? "hanging" : "down";
  switch (fault.kind) {
    case "slow":
      return { ...NO_FAULT, slowFactor: fault.factor, labels: [`${fault.factor}× slower`] };
    case "degraded":
      return {
        ...NO_FAULT,
        readCapacity: fault.capacity,
        writeCapacity: fault.capacity,
        labels: [`capacity at ${Math.round(fault.capacity * 100)}%`],
      };
    case "failover":
      return failoverEffect(shape, hangs);
    case "down":
      if (fault.scope === "all") return fail(1, hangs, [how]);
      if (fault.scope === "one-node") return nodeDown(shape, hangs, how);
      return shardDown(shape, hangs, how);
    case "zone-down":
      return zoneDown(shape, hangs, how, failingOver);
  }
}

/** Losing one instance: replicas or the provider absorb it, otherwise its keys fail. */
function nodeDown(shape: Shape, hangs: boolean, how: string): ComponentFault {
  if (shape.managed) return { ...NO_FAULT, labels: ["one node lost, replaced by the provider"] };
  const instances = shape.replicas * shape.shards;
  if (shape.quorum && shape.replicas >= 2 && shape.replicas - 1 <= shape.replicas / 2) {
    return quorumLost(
      shape,
      hangs,
      `${how}: one of its ${shape.replicas} replicas was its majority`,
    );
  }
  if (shape.replicas >= 2) {
    const remaining = (instances - 1) / instances;
    return {
      ...NO_FAULT,
      readCapacity: remaining,
      // A lost primary is replaced by its replica; the primaries still carry the writes.
      writeCapacity: shape.writesToPrimaries ? 1 : remaining,
      labels: ["one node lost, survived by replicas"],
    };
  }
  if (shape.shards >= 2) return shardDown(shape, hangs, how);
  return fail(1, hangs, [`${how} (its only node)`]);
}

/** Losing a whole shard: its share of keys fails. A provider keeps every partition replicated. */
function shardDown(shape: Shape, hangs: boolean, how: string): ComponentFault {
  if (shape.managed) return { ...NO_FAULT, labels: ["partition replaced by the provider"] };
  if (shape.shards < 2) return fail(1, hangs, [`${how} (its only shard)`]);
  const remaining = (shape.shards - 1) / shape.shards;
  return {
    ...fail(1 / shape.shards, hangs, [`one of ${shape.shards} shards ${how}`]),
    readCapacity: remaining,
    writeCapacity: remaining,
  };
}

/** A shard that lost half of its replicas stops. */
function quorumLost(shape: Shape, hangs: boolean, label: string): ComponentFault {
  if (shape.shards < 2) return fail(1, hangs, [label]);
  const remaining = (shape.shards - 1) / shape.shards;
  return {
    ...fail(1 / shape.shards, hangs, [label]),
    readCapacity: remaining,
    writeCapacity: remaining,
  };
}

interface ZoneOutcome {
  readonly zone: number;
  readonly lostInstances: number;
  /** Shards left without a replica, or without a majority of them. */
  readonly failedShards: number;
  /** Some shard failed because it lost its majority, not every replica. */
  readonly quorumLost: boolean;
}

/**
 * The zone whose loss hurts most: the most shards failed, then the most
 * instances lost, then the most primaries to replace.
 */
function worstZone(shape: Shape): ZoneOutcome {
  let worst: ZoneOutcome = { zone: 0, lostInstances: 0, failedShards: -1, quorumLost: false };
  for (let zone = 0; zone < shape.zones; zone++) {
    let lostInstances = 0;
    let failedShards = 0;
    let quorumLost = false;
    for (let shard = 0; shard < shape.shards; shard++) {
      const lost = replicasIn(zone, shard, shape);
      const left = shape.replicas - lost;
      lostInstances += lost;
      if (left === 0) failedShards++;
      else if (shape.quorum && left <= shape.replicas / 2) {
        failedShards++;
        quorumLost = true;
      }
    }
    const rank = [failedShards, lostInstances, primariesIn(zone, shape)];
    const best = [worst.failedShards, worst.lostInstances, primariesIn(worst.zone, shape)];
    const differs = rank.findIndex((value, i) => value !== best[i]);
    const worse = differs >= 0 && (rank[differs] ?? 0) > (best[differs] ?? 0);
    if (worse) worst = { zone, lostInstances, failedShards, quorumLost };
  }
  return worst;
}

/**
 * Losing an availability zone and every instance in it, in the zone where
 * that hurts most. A shard with a replica left elsewhere keeps its keys; one
 * without, or without a majority of its replicas where it needs one, loses
 * them. While the store is `failingOver`, writes to the shards whose primary
 * was in the zone fail too; after that a replica there has taken over.
 * Nothing has replaced the lost instances yet, so the rest carry the load.
 */
function zoneDown(shape: Shape, hangs: boolean, how: string, failingOver = false): ComponentFault {
  // The provider runs it in every zone and moves the lost zone's share to the others.
  if (shape.managed) return NO_FAULT;
  if (shape.zones < 2) return fail(1, hangs, [`${how}: every instance was in the lost zone`]);
  const zone = worstZone(shape);
  const lost = zoneLossEffect(shape, zone, hangs, how);
  if (!failingOver || !shape.primaries) return lost;
  const promoting = primariesIn(zone.zone, shape) / shape.shards;
  if (promoting <= lost.failWrite) return lost;
  const whose =
    shape.shards > 1
      ? `${primariesIn(zone.zone, shape)} of ${shape.shards} primaries`
      : "its primary";
  return {
    ...lost,
    failWrite: promoting,
    hang: lost.hang || hangs,
    labels: [...lost.labels, `${whose} failing over; writes to them fail`],
  };
}

function zoneLossEffect(
  shape: Shape,
  zone: ZoneOutcome,
  hangs: boolean,
  how: string,
): ComponentFault {
  const instances = shape.replicas * shape.shards;
  const lostShare = shape.autoscaled ? 1 / shape.zones : zone.lostInstances / instances;
  const failedShare = zone.failedShards / shape.shards;
  if (failedShare === 0) {
    return {
      ...NO_FAULT,
      readCapacity: 1 - lostShare,
      // Primaries in the lost zone have failed over; every shard still has one.
      writeCapacity: shape.writesToPrimaries ? 1 : 1 - lostShare,
      labels: [`lost ${Math.round(lostShare * 100)}% of its instances with a zone`],
    };
  }
  const label = zoneFailureLabel(shape, zone, how);
  if (failedShare === 1) return fail(1, hangs, [label]);
  return {
    ...fail(failedShare, hangs, [label]),
    readCapacity: 1 - lostShare,
    writeCapacity: 1 - failedShare,
  };
}

function zoneFailureLabel(shape: Shape, zone: ZoneOutcome, how: string): string {
  if (!zone.quorumLost) {
    return `${zone.failedShards} of ${shape.shards} shards ${how} with the lost zone`;
  }
  if (shape.shards === 1) {
    return `${how}: the lost zone held ${zone.lostInstances} of its ${shape.replicas} replicas, a majority`;
  }
  const which =
    zone.failedShards === shape.shards
      ? "every shard"
      : `${zone.failedShards} of ${shape.shards} shards`;
  return `${how}: the lost zone held a majority of the replicas of ${which}`;
}

/**
 * What losing a zone does to a component: whether it keeps every key, the
 * share of its read capacity left, and what happened, as the fault reports it.
 */
export function zoneLoss(
  component: Component,
  catalog: CatalogIndex,
): { readonly keepsServing: boolean; readonly capacityLeft: number; readonly label: string } {
  if (!runsInZones(component, catalog)) {
    return { keepsServing: true, capacityLeft: 1, label: "not in a zone of its own" };
  }
  const shape = shapeOf(component, catalog);
  if (shape.managed) return { keepsServing: true, capacityLeft: 1, label: "spans zones (managed)" };
  const effect = zoneDown(shape, false, "down");
  return {
    keepsServing: effect.failRead === 0 && effect.failWrite === 0,
    capacityLeft: effect.failRead === 1 ? 0 : effect.readCapacity,
    label: effect.labels.join("; "),
  };
}

/**
 * A primary is lost and a replica is being promoted. Writes to that shard fail
 * until the promotion completes; reads continue on its replicas if it has any.
 */
function failoverEffect(shape: Shape, hangs: boolean): ComponentFault {
  if (shape.managed) return { ...NO_FAULT, labels: ["fails over transparently (managed)"] };
  if (!shape.primaries) return { ...NO_FAULT, labels: ["no primary to fail over"] };
  const share = 1 / shape.shards;
  const instances = shape.replicas * shape.shards;
  const scope = shape.shards > 1 ? `one of ${shape.shards} primaries` : "the primary";
  if (shape.replicas < 2) {
    return fail(share, hangs, [`${scope} lost with no replica to promote`]);
  }
  return {
    ...NO_FAULT,
    failWrite: share,
    hang: hangs,
    readCapacity: (instances - 1) / instances,
    writeCapacity: (shape.shards - 1) / shape.shards,
    labels: [`${scope} failing over; writes to it fail, reads continue on replicas`],
  };
}

/** A component's capacity and service time under its faults. */
export function faultedProfile(profile: ComponentProfile, fault: ComponentFault): ComponentProfile {
  if (fault.readCapacity === 1 && fault.writeCapacity === 1 && fault.slowFactor === 1) {
    return profile;
  }
  return {
    ...profile,
    readCapacity: (profile.readCapacity * fault.readCapacity) / fault.slowFactor,
    writeCapacity: (profile.writeCapacity * fault.writeCapacity) / fault.slowFactor,
    // Lost instances take their network with them; a slow one still has all of its own.
    outboundBytesPerSec: profile.outboundBytesPerSec * fault.readCapacity,
    serviceTimeMs: profile.serviceTimeMs * fault.slowFactor,
    // Concurrency is capacity × service time, so slowness does not change it.
    servers: Math.max(1, Math.round(profile.servers * fault.readCapacity)),
  };
}
