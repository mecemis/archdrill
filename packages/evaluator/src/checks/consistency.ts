import type { Path, PathStep } from "@archdrill/engine";
import { ACTIONS, liveStepIds } from "@archdrill/model";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { isSuccessPath } from "../predicates";
import { type CheckContext, defineCheck, graded, notApplicable, passed } from "./types";

const STORE_WRITES = new Set(["write", "conditional-write", "delete"]);

const isStoreWrite = (step: PathStep, entity: string) =>
  step.kind === "call" &&
  step.outcome === "ok" &&
  step.entity === entity &&
  STORE_WRITES.has(ACTIONS[step.action].effect);

/** A delete that succeeded: a failed one leaves the old version in place. */
const isCacheDelete = (step: PathStep, entity: string, cache: string) =>
  step.kind === "call" &&
  step.action === "cache.delete" &&
  step.outcome === "ok" &&
  step.entity === entity &&
  step.target === cache;

/** Whether the path deletes the cache entry after storing the change, and whether only before. */
function deletion(path: Path, entity: string, cache: string): "after" | "before" | "none" {
  const write = path.steps.findIndex((s) => isStoreWrite(s, entity));
  const deletes = path.steps.flatMap((s, i) => (isCacheDelete(s, entity, cache) ? [i] : []));
  if (deletes.some((i) => i > write)) return "after";
  return deletes.length > 0 ? "before" : "none";
}

/** Longest TTL any live flow gives the entity in this cache; null when some entry has none. */
function longestTtl(ctx: CheckContext, entity: string, cache: string): number | null {
  let longest = 0;
  for (const flow of ctx.attempt.flows) {
    for (const id of liveStepIds(flow, ctx.attempt)) {
      const step = flow.steps[id];
      if (step?.type !== "call" || step.action !== "cache.set") continue;
      if (step.target !== cache || step.entity !== entity) continue;
      if (step.ttlSec === undefined) return null;
      longest = Math.max(longest, step.ttlSec);
    }
  }
  return longest;
}

const duration = (sec: number | null) => {
  if (sec === null) return "until it is evicted";
  if (sec < 120) return `${sec} s`;
  return sec < 7200 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 3600)} h`;
};

/**
 * After a write changes an entity, caches on the read path stop serving the
 * old version within the staleness budget: the write deletes the cached entry
 * after storing the change, or entries expire soon enough on their own.
 */
export const invalidationOnWrite = defineCheck({
  id: "invalidation-on-write",
  description: "Caches stop serving an entity's old version soon enough after it changes.",
  params: z.strictObject({
    operation: z.string().min(1),
    readOperation: z.string().min(1),
    entity: z.string().min(1),
    maxStalenessSec: z.number().positive(),
  }),
  run(params, ctx) {
    const write = ctx.analysis.operations.get(params.operation);
    const read = ctx.analysis.operations.get(params.readOperation);
    if (!write?.flow || !read) return notApplicable("The operations are not recorded yet.");
    const writing = write.paths.filter(
      (p) =>
        isSuccessPath(p, write.operation) && p.steps.some((s) => isStoreWrite(s, params.entity)),
    );
    const caches = new Set(
      read.paths.flatMap((p) =>
        p.steps.flatMap((s) =>
          s.kind === "call" && s.action === "cache.get" && s.entity === params.entity
            ? [s.target]
            : [],
        ),
      ),
    );
    if (caches.size === 0) {
      return passed(`Nothing caches ${params.entity} on the read path, so changes show at once.`);
    }
    if (writing.length === 0) {
      return {
        status: "fail",
        fraction: 0,
        message: `No successful path of ${write.operation.label} stores the change to ${params.entity}.`,
        details: [],
        evidence: [],
      };
    }
    const label = (id: string) =>
      ctx.attempt.architecture.components.find((c) => c.id === id)?.label ?? id;
    const problems: { cache: string; line: string }[] = [];
    for (const cache of caches) {
      const ttl = longestTtl(ctx, params.entity, cache);
      const bounded = ttl !== null && ttl <= params.maxStalenessSec;
      const kinds = writing.map((p) => deletion(p, params.entity, cache));
      if (bounded || kinds.every((k) => k === "after")) continue;
      const stale = `for up to ${duration(ttl)}; the budget is ${duration(params.maxStalenessSec)}`;
      problems.push({
        cache,
        line: kinds.some((k) => k === "before")
          ? `${label(cache)} is deleted before the store is updated: a read in between caches the old version again, which is then served ${stale}.`
          : `${label(cache)} keeps serving the old version ${stale}.`,
      });
    }
    if (problems.length === 0) {
      return passed(
        `Every cache of ${params.entity} stops serving a change within ${duration(params.maxStalenessSec)}.`,
      );
    }
    const evidence: Evidence[] = problems.map((p) => ({ type: "component", componentId: p.cache }));
    return graded(
      caches.size - problems.length,
      caches.size,
      problems[0]?.line ?? "",
      evidence,
      problems.slice(1).map((p) => p.line),
    );
  },
});
