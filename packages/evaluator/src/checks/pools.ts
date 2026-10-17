import type { ComponentMetrics, PoolMetrics } from "@archdrill/engine";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { type CheckContext, defineCheck, failed, notApplicable, passed } from "./types";

const percent = (value: number) => `${Math.round(value * 100)}%`;
const count = (value: number) => Math.round(value).toLocaleString("en-US");
const ms = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;

function label(ctx: CheckContext, componentId: string): string {
  return (
    ctx.attempt.architecture.components.find((c) => c.id === componentId)?.label ?? componentId
  );
}

function ends(ctx: CheckContext, connectionId: string) {
  const connection = ctx.attempt.architecture.connections.find((c) => c.id === connectionId);
  return {
    caller: connection ? label(ctx, connection.from) : connectionId,
    store: connection ? label(ctx, connection.to) : connectionId,
    target: connection?.to ?? "",
  };
}

/** One pool's sums, from Little's law: calls a second times how long each holds a connection. */
function poolDetail(ctx: CheckContext, pool: PoolMetrics): string {
  const { caller, store } = ends(ctx, pool.connectionId);
  const perInstance = pool.holdMs > 0 ? (pool.inFlight / pool.holdMs) * 1000 : 0;
  const connections = pool.poolSize * pool.copies;
  const spread = pool.copies > 1 ? ` (${pool.poolSize} to each of ${pool.copies} copies)` : "";
  const exhausted =
    pool.exhausted > 0
      ? `; ${percent(pool.exhausted)} of its calls find none free and wait until they give up`
      : "";
  return `${caller} → ${store}: ${count(perInstance)} calls a second per instance × ${ms(pool.holdMs)} = ${pool.inFlight.toFixed(1)} in flight, on ${count(connections)} connections${spread}: ${percent(pool.utilization)} busy${exhausted}.`;
}

/** Whose pools fill a store's primary, instances × pool size each. */
function storeDetail(
  ctx: CheckContext,
  store: ComponentMetrics,
  pools: readonly PoolMetrics[],
): string {
  const open = store.connections?.open ?? 0;
  const limit = store.connections?.limit ?? 0;
  const callers = pools
    .filter((p) => !p.proxied && ends(ctx, p.connectionId).target === store.componentId)
    .map((p) => `${p.callerInstances} ${ends(ctx, p.connectionId).caller} × ${p.poolSize}`);
  return `${label(ctx, store.componentId)}: ${callers.join(" + ")} = ${count(open)} connections on each primary, over its limit of ${count(limit)}; the rest are refused.`;
}

/**
 * Pools fit the work and the store: each caller's pools keep headroom for the
 * statements it has in flight (calls a second times their latency), and every
 * caller instance's pools together fit the store's connection limit.
 */
export const connectionPools = defineCheck({
  id: "connection-pools",
  description:
    "Connection pools hold the statements in flight, and fit within the store's connection limit.",
  params: z.strictObject({
    environment: z.string().min(1),
    /** Busiest a pool may be: above it, a burst leaves calls waiting for a connection. */
    maxUtilization: z.number().positive().max(1).default(0.8),
  }),
  run(params, ctx) {
    const env = ctx.metrics.get(params.environment);
    if (!env) return notApplicable("This scenario does not simulate load.");
    const pools = [...env.pools.values()];
    if (pools.length === 0) {
      return notApplicable("No caller holds pooled connections to a store.");
    }
    const tight = pools
      .filter((p) => p.utilization > params.maxUtilization)
      .sort((a, b) => b.utilization - a.utilization);
    // Only the stores the pools reach: a gateway's held client connections are another check's.
    const pooledStores = new Set(
      pools.filter((p) => !p.proxied).map((p) => ends(ctx, p.connectionId).target),
    );
    const stores = [...env.components.values()].filter(
      (c) => c.connections && pooledStores.has(c.componentId),
    );
    const over = stores.filter((c) => c.connections && c.connections.open > c.connections.limit);
    const where = env.environment.label;
    if (tight.length === 0 && over.length === 0) {
      const fullest = [...pools].sort((a, b) => b.utilization - a.utilization)[0];
      const held = stores.map(
        (c) =>
          `${label(ctx, c.componentId)} holds ${count(c.connections?.open ?? 0)} of the ${count(c.connections?.limit ?? 0)} connections each primary accepts`,
      );
      return passed(
        [
          fullest ? `The fullest pool is ${percent(fullest.utilization)} busy at ${where}.` : "",
          held.length > 0 ? `${held.join("; ")}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    const evidence: Evidence[] = [
      ...over.map((c): Evidence => ({ type: "component", componentId: c.componentId })),
      ...tight.map((p): Evidence => ({ type: "connection", connectionId: p.connectionId })),
    ];
    const details = [
      ...over.map((c) => storeDetail(ctx, c, pools)),
      ...tight.map((p) => poolDetail(ctx, p)),
    ];
    const [store] = over;
    if (store?.connections) {
      return failed(
        `${label(ctx, store.componentId)} would hold ${count(store.connections.open)} connections on each primary at ${where}, over its limit of ${count(store.connections.limit)}: the pools beyond it are refused, and their requests with them.`,
        evidence,
        details,
      );
    }
    const [fullest] = tight;
    if (fullest && fullest.exhausted > 0) {
      const { caller, store: target } = ends(ctx, fullest.connectionId);
      return failed(
        `${caller}'s pools to ${target} are ${percent(fullest.utilization)} busy at ${where}: ${percent(fullest.exhausted)} of its calls find no free connection and wait until they give up.`,
        evidence,
        details,
      );
    }
    return {
      status: "partial",
      fraction: 0.5,
      message: `${tight.length} caller${tight.length === 1 ? "'s pools run" : "s' pools run"} above ${percent(params.maxUtilization)} at ${where}, leaving no headroom for a burst.`,
      details,
      evidence,
    };
  },
});
