import { ACTIONS, type Attempt } from "@archdrill/model";
import type { ComponentProfile } from "./capacity";
import type { ComponentFault } from "./faults";
import type { Moments } from "./math/gamma";
import { queueWait } from "./math/queueing";
import type { SimulationContext } from "./setup";
import type { PoolMetrics } from "./types";
import { NETWORK_HOP, networkHop, type RouteHops } from "./zone-traffic";

/** Connections a pool keeps when the caller sets none: HikariCP's and node-postgres's default. */
export const DEFAULT_POOL_SIZE = 10;

/**
 * The pools a caller keeps to a store that runs one statement per connection.
 * Every caller instance keeps its own pool to each copy it calls: each
 * shard's primary, and the shard's replicas too when it reads from them.
 */
export interface PoolSpec {
  readonly connectionId: string;
  readonly caller: string;
  readonly target: string;
  /** Connections each caller instance keeps to each copy it calls. */
  readonly poolSize: number;
  /** Copies of the target each caller instance keeps a pool to. */
  readonly copies: number;
  /** Milliseconds the target's connection proxy adds to each call; 0 without one. */
  readonly proxyMs: number;
}

const SPECS = new WeakMap<Attempt, readonly PoolSpec[]>();

/** The design's pools, worked out once per design. */
export function poolSpecs(ctx: SimulationContext): readonly PoolSpec[] {
  const known = SPECS.get(ctx.attempt);
  if (known) return known;
  // Eventual reads spread over a shard's copies; writes and consistent reads go to its primary.
  const readsReplicas = new Set<string>();
  for (const analysis of ctx.analysis.operations.values()) {
    for (const path of analysis.paths) {
      for (const step of path.steps) {
        if (
          step.kind === "call" &&
          step.connectionId !== null &&
          ACTIONS[step.action].effect === "read" &&
          !step.consistent
        ) {
          readsReplicas.add(step.connectionId);
        }
      }
    }
  }
  const components = new Map(ctx.attempt.architecture.components.map((c) => [c.id, c]));
  const specs: PoolSpec[] = [];
  for (const connection of ctx.attempt.architecture.connections) {
    const target = components.get(connection.to);
    const caller = components.get(connection.from);
    if (!target || !caller) continue;
    const kind = ctx.catalog.kind(target.kind);
    const callerKind = ctx.catalog.kind(caller.kind);
    if (!kind?.pooledConnections || !callerKind || callerKind.inProcess) continue;
    // Clients call through the design's way in; only its own instances hold pools.
    if (ctx.catalog.capabilities(caller.kind, caller.flavor).has("traffic-source")) continue;
    const proxy = ctx.catalog.flavor(target.kind, target.flavor)?.connectionProxy;
    const shards = kind.shardable ? target.shards : 1;
    specs.push({
      connectionId: connection.id,
      caller: caller.id,
      target: target.id,
      poolSize: connection.policy.poolSize ?? DEFAULT_POOL_SIZE,
      copies: readsReplicas.has(connection.id) ? shards * target.replicas : shards,
      proxyMs: target.proxy && proxy ? proxy.latencyMs : 0,
    });
  }
  SPECS.set(ctx.attempt, specs);
  return specs;
}

/**
 * Connections the callers' pools open on a shard's primary, the copy every
 * caller reaches, by target. A connection proxy holds the callers' pools
 * instead and opens a database connection only while a statement runs on it,
 * which the database's own capacity keeps far below its limit.
 */
export function openConnections(
  specs: readonly PoolSpec[],
  profiles: ReadonlyMap<string, ComponentProfile>,
  faults: ReadonlyMap<string, ComponentFault>,
): Map<string, number> {
  const open = new Map<string, number>();
  for (const spec of specs) {
    if (spec.proxyMs > 0) continue;
    const instances = liveInstances(spec.caller, profiles, faults);
    open.set(spec.target, (open.get(spec.target) ?? 0) + instances * spec.poolSize);
  }
  return open;
}

/**
 * Instances of a caller still running: a fault that takes instances away
 * (a crash, a lost zone) takes their share of its capacity, and their pools.
 */
export function liveInstances(
  id: string,
  profiles: ReadonlyMap<string, ComponentProfile>,
  faults: ReadonlyMap<string, ComponentFault>,
): number {
  const instances = profiles.get(id)?.instances ?? 0;
  return instances * Math.min(1, faults.get(id)?.readCapacity ?? 1);
}

export interface PoolState {
  /** Milliseconds a call holds its connection. */
  readonly holdMs: number;
  /** Statements in flight per caller instance, from Little's law: calls a second times their latency. */
  readonly inFlight: number;
  /** In-flight statements over the connections the caller's pools hold; above 1 some calls find none free. */
  readonly utilization: number;
  /** Share of attempts that find no free connection and wait until they give up. */
  readonly exhausted: number;
  /** Milliseconds an attempt that gets a connection waited for it. */
  readonly waitMs: number;
}

export const IDLE_POOL: PoolState = {
  holdMs: 0,
  inFlight: 0,
  utilization: 0,
  exhausted: 0,
  waitMs: 0,
};

/**
 * A caller's pools to one store. Each pool is a queue for its connections:
 * `poolSize` servers whose service time is the call's latency. Calls spread
 * evenly over the caller's instances and the copies they call.
 */
export function poolState(
  spec: PoolSpec,
  /** Attempts a second that ask for a connection, over every caller instance. */
  attemptsPerSec: number,
  callerInstances: number,
  /** Milliseconds a call holds its connection: the store's latency and the round trip. */
  holdMs: number,
): PoolState {
  if (attemptsPerSec <= 0 || callerInstances <= 0 || holdMs <= 0) return IDLE_POOL;
  const inFlight = (attemptsPerSec / callerInstances) * (holdMs / 1000);
  const utilization = inFlight / (spec.poolSize * spec.copies);
  return {
    holdMs,
    inFlight,
    utilization,
    exhausted: utilization > 1 ? 1 - 1 / utilization : 0,
    waitMs: queueWait(utilization, spec.poolSize, holdMs),
  };
}

/** A connection proxy's hop on every call to the store behind it. */
export function withProxyHops(
  hops: Map<string, RouteHops>,
  specs: readonly PoolSpec[],
): Map<string, RouteHops> {
  for (const spec of specs) {
    if (spec.proxyMs <= 0) continue;
    const route = hops.get(spec.connectionId) ?? { read: NETWORK_HOP, write: NETWORK_HOP };
    const proxy = networkHop(spec.proxyMs);
    hops.set(spec.connectionId, {
      read: addMoments(route.read, proxy),
      write: addMoments(route.write, proxy),
    });
  }
  return hops;
}

const addMoments = (a: Moments, b: Moments): Moments => ({
  mean: a.mean + b.mean,
  variance: a.variance + b.variance,
});

/** Pool metrics per pooled connection. */
export function summarizePools(
  specs: readonly PoolSpec[],
  states: ReadonlyMap<string, PoolState>,
  profiles: ReadonlyMap<string, ComponentProfile>,
  faults: ReadonlyMap<string, ComponentFault>,
): Map<string, PoolMetrics> {
  return new Map(
    specs.map((spec) => {
      const state = states.get(spec.connectionId) ?? IDLE_POOL;
      return [
        spec.connectionId,
        {
          connectionId: spec.connectionId,
          poolSize: spec.poolSize,
          copies: spec.copies,
          callerInstances: liveInstances(spec.caller, profiles, faults),
          ...state,
          proxied: spec.proxyMs > 0,
        },
      ];
    }),
  );
}
