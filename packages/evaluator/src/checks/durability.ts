import { selectComponents } from "@archdrill/engine";
import { ACTIONS, type Component } from "@archdrill/model";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { isSuccessPath } from "../predicates";
import { type CheckContext, defineCheck, failed, notApplicable, passed } from "./types";

/** Typical lag of asynchronous replicas under load: writes acknowledged in this window are lost on failover. */
export const ASYNC_REPLICATION_LAG_SEC = 1;

const SAFE_MODES = new Set(["semi-sync", "sync"]);

/** Stores that the operation's successful paths write to. */
function storesWritten(ctx: CheckContext, operation: string): Set<string> {
  const op = ctx.analysis.operations.get(operation);
  const written = new Set<string>();
  for (const path of op?.paths ?? []) {
    if (!op || !isSuccessPath(path, op.operation)) continue;
    for (const step of path.steps) {
      if (step.kind !== "call" || step.outcome !== "ok") continue;
      const effect = ACTIONS[step.action].effect;
      if (effect === "write" || effect === "conditional-write") written.add(step.target);
    }
  }
  return written;
}

/** Why a failover of this store cannot lose acknowledged writes, or null if it can. */
function whySafe(store: Component, ctx: CheckContext, mode: string | undefined): string | null {
  if (ctx.catalog.flavor(store.kind, store.flavor)?.managedRedundancy) {
    return `${store.label} replicates synchronously across zones (managed)`;
  }
  if (store.replicas < 2) {
    return `${store.label} has no replica to promote, so writes wait for it to restart`;
  }
  if (mode && SAFE_MODES.has(mode)) {
    return `${store.label} waits for a replica before acknowledging (${mode})`;
  }
  return null;
}

/** A failover never loses a write that the user was already told succeeded. */
export const noAcknowledgedDataLoss = defineCheck({
  id: "no-acknowledged-data-loss",
  description: "A failover does not lose writes that were already acknowledged.",
  params: z.strictObject({
    operation: z.string().min(1),
    environment: z.string().min(1),
    /** Decision point that records how stores replicate writes. */
    decision: z.string().min(1),
  }),
  run(params, ctx) {
    const env = ctx.metrics.get(params.environment);
    if (!env) return notApplicable("This scenario does not simulate that environment.");
    const failing = new Set(
      env.environment.faults
        .filter((f) => f.kind === "failover")
        .flatMap((f) => selectComponents(f.target, ctx.attempt, ctx.catalog).map((c) => c.id)),
    );
    const written = storesWritten(ctx, params.operation);
    const stores = ctx.attempt.architecture.components.filter(
      (c) => failing.has(c.id) && written.has(c.id),
    );
    if (stores.length === 0) return notApplicable("Nothing this operation writes fails over here.");
    const mode = ctx.attempt.decisions[params.decision];
    const atRisk = stores.filter((s) => whySafe(s, ctx, mode) === null);
    if (atRisk.length === 0) {
      const reasons = stores.map((s) => whySafe(s, ctx, mode)).join("; ");
      return passed(`No acknowledged write is lost: ${reasons}.`);
    }
    const rate = env.environment.rates[params.operation] ?? 0;
    const lost = atRisk.map((s) => {
      const shards = ctx.catalog.kind(s.kind)?.shardable ? s.shards : 1;
      return Math.round((rate / shards) * ASYNC_REPLICATION_LAG_SEC);
    });
    const total = lost.reduce((sum, n) => sum + n, 0).toLocaleString("en-US");
    const labels = atRisk.map((s) => s.label).join(", ");
    const evidence: Evidence[] = atRisk.map((s) => ({ type: "component", componentId: s.id }));
    const window = `in the last ${ASYNC_REPLICATION_LAG_SEC} s before the failover (about ${total} at ${env.environment.label})`;
    return failed(
      mode === undefined
        ? `You have not decided how ${labels} replicates writes. With asynchronous replication, the usual default, writes acknowledged ${window} are lost.`
        : `${labels} replicates asynchronously: writes acknowledged ${window} are lost.`,
      evidence,
    );
  },
});
