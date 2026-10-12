import type { Attempt, CatalogIndex, Component, ComponentSelector, Fault } from "@archdrill/model";
import type { ComponentProfile } from "./capacity";

/** The combined effect of an environment's faults on one component. */
export interface ComponentFault {
  /** Share of calls that fail because of the fault, for calls that read and that change data. */
  readonly failRead: number;
  readonly failWrite: number;
  /** Failed calls hang until the caller gives up, instead of being refused at once. */
  readonly hang: boolean;
  /** Multiplier on capacity: lost nodes or degradation. */
  readonly capacityFactor: number;
  /** Multiplier on service time; capacity divides by it too. */
  readonly slowFactor: number;
  /** What happened, for people: "down", "one node down (survived by replicas)". */
  readonly labels: readonly string[];
}

export const NO_FAULT: ComponentFault = {
  failRead: 0,
  failWrite: 0,
  hang: false,
  capacityFactor: 1,
  slowFactor: 1,
  labels: [],
};

/** Components a selector picks: all fields must match. */
export function selectComponents(
  selector: ComponentSelector,
  attempt: Attempt,
  catalog: CatalogIndex,
): Component[] {
  return attempt.architecture.components.filter((c) => {
    if (selector.kind && c.kind !== selector.kind) return false;
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

/** Per component, the combined effect of every fault in the environment. */
export function resolveFaults(
  faults: readonly Fault[],
  attempt: Attempt,
  catalog: CatalogIndex,
): Map<string, ComponentFault> {
  const result = new Map<string, ComponentFault>();
  for (const fault of faults) {
    for (const component of selectComponents(fault.target, attempt, catalog)) {
      const effect = faultEffect(fault, component, catalog);
      result.set(component.id, combine(result.get(component.id) ?? NO_FAULT, effect));
    }
  }
  return result;
}

function combine(a: ComponentFault, b: ComponentFault): ComponentFault {
  return {
    failRead: 1 - (1 - a.failRead) * (1 - b.failRead),
    failWrite: 1 - (1 - a.failWrite) * (1 - b.failWrite),
    hang: a.hang || b.hang,
    capacityFactor: a.capacityFactor * b.capacityFactor,
    slowFactor: a.slowFactor * b.slowFactor,
    labels: [...a.labels, ...b.labels],
  };
}

interface Shape {
  /** Instances that each hold a full copy of one shard (1 for managed or non-replicable kinds). */
  readonly replicas: number;
  readonly shards: number;
  /** The provider replaces failed nodes and fails over without the design's help. */
  readonly managed: boolean;
  /** Writes go to one primary per shard, which a failover has to replace. */
  readonly primaries: boolean;
}

function shapeOf(component: Component, catalog: CatalogIndex): Shape {
  const kind = catalog.kind(component.kind);
  const managed = catalog.flavor(component.kind, component.flavor)?.managedRedundancy ?? false;
  return {
    replicas: kind?.replicable && !managed ? component.replicas : 1,
    shards: kind?.shardable ? component.shards : 1,
    managed,
    primaries: (kind?.holdsData ?? false) && kind?.writeScaling === "primaries",
  };
}

const fail = (share: number, hang: boolean, labels: string[]): ComponentFault => ({
  ...NO_FAULT,
  failRead: share,
  failWrite: share,
  hang,
  labels,
});

function faultEffect(fault: Fault, component: Component, catalog: CatalogIndex): ComponentFault {
  const shape = shapeOf(component, catalog);
  const hangs = "mode" in fault && fault.mode === "hang";
  const how = hangs ? "hanging" : "down";
  switch (fault.kind) {
    case "slow":
      return { ...NO_FAULT, slowFactor: fault.factor, labels: [`${fault.factor}× slower`] };
    case "degraded":
      return {
        ...NO_FAULT,
        capacityFactor: fault.capacity,
        labels: [`capacity at ${Math.round(fault.capacity * 100)}%`],
      };
    case "failover":
      return failoverEffect(shape, hangs);
    case "down":
      if (fault.scope === "all") return fail(1, hangs, [how]);
      if (fault.scope === "one-node") return nodeDown(shape, hangs, how);
      return shardDown(shape, hangs, how);
  }
}

/** Losing one instance: replicas or the provider absorb it, otherwise its keys fail. */
function nodeDown(shape: Shape, hangs: boolean, how: string): ComponentFault {
  if (shape.managed) return { ...NO_FAULT, labels: ["one node lost, replaced by the provider"] };
  const instances = shape.replicas * shape.shards;
  if (shape.replicas >= 2) {
    return {
      ...NO_FAULT,
      capacityFactor: (instances - 1) / instances,
      labels: ["one node lost, survived by replicas"],
    };
  }
  if (shape.shards >= 2) return shardDown(shape, hangs, how);
  return fail(1, hangs, [`${how} (its only node)`]);
}

/** Losing a whole shard: its share of keys fails. */
function shardDown(shape: Shape, hangs: boolean, how: string): ComponentFault {
  if (shape.shards < 2) return fail(1, hangs, [`${how} (its only shard)`]);
  return {
    ...fail(1 / shape.shards, hangs, [`one of ${shape.shards} shards ${how}`]),
    capacityFactor: (shape.shards - 1) / shape.shards,
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
    capacityFactor: (instances - 1) / instances,
    labels: [`${scope} failing over; writes to it fail, reads continue on replicas`],
  };
}

/** A component's capacity and service time under its faults. */
export function faultedProfile(profile: ComponentProfile, fault: ComponentFault): ComponentProfile {
  if (fault.capacityFactor === 1 && fault.slowFactor === 1) return profile;
  const capacity = fault.capacityFactor / fault.slowFactor;
  return {
    ...profile,
    readCapacity: profile.readCapacity * capacity,
    writeCapacity: profile.writeCapacity * capacity,
    serviceTimeMs: profile.serviceTimeMs * fault.slowFactor,
    // Concurrency is capacity × service time, so slowness does not change it.
    servers: Math.max(1, Math.round(profile.servers * fault.capacityFactor)),
  };
}
