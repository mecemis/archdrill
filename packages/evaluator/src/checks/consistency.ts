import {
  hasStandby,
  type Path,
  type PathStep,
  singleWriter,
  staleReadReason,
} from "@archdrill/engine";
import { ACTIONS, liveStepIds } from "@archdrill/model";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { isSuccessPath, pathStatus, servesResource } from "../predicates";
import { ASYNC_REPLICATION_LAG_SEC } from "./durability";
import { type CheckContext, defineCheck, failed, graded, notApplicable, passed } from "./types";

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

function inProcess(ctx: CheckContext, componentId: string): boolean {
  const component = ctx.attempt.architecture.components.find((c) => c.id === componentId);
  return component ? (ctx.catalog.kind(component.kind)?.inProcess ?? false) : false;
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
        evidence: write.paths
          .filter((p) => isSuccessPath(p, write.operation))
          .map((p): Evidence => ({ type: "path", operation: write.operation.id, pathId: p.id })),
      };
    }
    const label = (id: string) =>
      ctx.attempt.architecture.components.find((c) => c.id === id)?.label ?? id;
    const problems: { cache: string; line: string }[] = [];
    for (const cache of caches) {
      const ttl = longestTtl(ctx, params.entity, cache);
      const bounded = ttl !== null && ttl <= params.maxStalenessSec;
      const stale = `for up to ${duration(ttl)}; the budget is ${duration(params.maxStalenessSec)}`;
      if (inProcess(ctx, cache)) {
        // One copy per instance: a delete reaches only the instance that ran the write.
        if (!bounded) {
          problems.push({
            cache,
            line: `${label(cache)} keeps a copy in every instance, and a delete reaches only one of them; the others serve the old version ${stale}.`,
          });
        }
        continue;
      }
      const kinds = writing.map((p) => deletion(p, params.entity, cache));
      if (bounded || kinds.every((k) => k === "after")) continue;
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

/** Actions that create an entity: what a read right after should find. */
const CREATES = new Set(["store.insert", "store.insertIfAbsent"]);

const isCreate = (step: PathStep, entity: string) =>
  step.kind === "call" &&
  step.outcome === "ok" &&
  step.entity === entity &&
  CREATES.has(step.action);

/** A publish of an event about the entity: a consumer stores it later. */
const isPublishOf = (step: PathStep, entity: string, ctx: CheckContext) =>
  step.kind === "call" &&
  step.action === "queue.publish" &&
  step.outcome === "ok" &&
  ctx.problem.events.some((e) => e.id === step.event && e.entity === entity);

/**
 * Caches that every one of the paths fills with the entity after `from`.
 * The check takes the cache as up: a fill or a lookup that fails is the
 * outage's problem, which scenarios about cache outages judge.
 */
function primedCaches(
  paths: readonly Path[],
  entity: string,
  from: (step: PathStep) => boolean,
): Set<string> {
  const filled = paths.map(
    (path) =>
      new Set(
        path.steps.flatMap((s, i) =>
          s.kind === "call" &&
          s.action === "cache.set" &&
          s.entity === entity &&
          path.steps.slice(0, i).some(from)
            ? [s.target]
            : [],
        ),
      ),
  );
  const [first, ...rest] = filled;
  return new Set([...(first ?? [])].filter((id) => rest.every((set) => set.has(id))));
}

/**
 * The store read that answers "not found" for a fresh entity on this path,
 * or null: the path's last read of the entity, missing it at a store that
 * may not have it yet, with no cache the write filled looked up first.
 * `missing` says whether a read of a store can miss the write.
 */
function exposingRead(
  path: Path,
  entity: string,
  missing: (step: Extract<PathStep, { kind: "call" }>) => boolean,
  primed: ReadonlySet<string>,
): Extract<PathStep, { kind: "call" }> | null {
  const reads = path.steps.flatMap((s, i) =>
    s.kind === "call" && s.action === "store.read" && s.entity === entity ? [i] : [],
  );
  const last = reads[reads.length - 1];
  const step = last === undefined ? undefined : path.steps[last];
  if (step?.kind !== "call" || step.outcome !== "notFound" || !missing(step)) return null;
  const looked = path.steps
    .slice(0, last)
    .some(
      (s) =>
        s.kind === "call" &&
        s.action === "cache.get" &&
        s.entity === entity &&
        primed.has(s.target),
    );
  return looked ? null : step;
}

/** Longest TTL an exposed path gives the "not found" it caches, or null when none caches it. */
function cachedMiss(paths: readonly Path[], entity: string): number | null {
  const ttls = paths.flatMap((path) =>
    path.steps.flatMap((s) =>
      s.kind === "call" &&
      s.action === "cache.setNegative" &&
      s.outcome === "ok" &&
      s.entity === entity
        ? [s.ttlSec ?? 0]
        : [],
    ),
  );
  return ttls.length > 0 ? Math.max(...ttls) : null;
}

function labelOf(ctx: CheckContext, id: string): string {
  return ctx.attempt.architecture.components.find((c) => c.id === id)?.label ?? id;
}

/**
 * A read made right after a create finds what it created: the create fills
 * a cache the read looks in first, or the read that answers "not found" is
 * consistent, or the store has no copy that could lag behind its
 * acknowledged writes. A create that answers before anything stores the
 * entity (a consumer stores it later) needs the cache.
 */
export const readYourWrites = defineCheck({
  id: "read-your-writes",
  description: "A read made right after a create finds what it created.",
  params: z.strictObject({
    writeOperation: z.string().min(1),
    readOperation: z.string().min(1),
    entity: z.string().min(1),
    /** Decision point that records how stores with a primary replicate writes. */
    decision: z.string().min(1).optional(),
  }),
  run(params, ctx) {
    const writeOp = ctx.analysis.operations.get(params.writeOperation);
    const readOp = ctx.analysis.operations.get(params.readOperation);
    if (!writeOp || !readOp) return notApplicable("Both operations need a flow.");
    const entity = params.entity;
    const answered = writeOp.paths.filter(servesResource);
    const stored = answered.filter((p) => p.steps.some((s) => isCreate(s, entity)));
    const published = answered.filter(
      (p) => !stored.includes(p) && p.steps.some((s) => isPublishOf(s, entity, ctx)),
    );
    const writing = [...stored, ...published];
    if (writing.length === 0) return notApplicable(`Nothing creates ${entity} yet.`);
    const written = (s: PathStep) => isCreate(s, entity) || isPublishOf(s, entity, ctx);
    const primed = primedCaches(writing, entity, written);
    const write = writeOp.operation.label.toLowerCase();
    const read = readOp.operation.label;

    // A create that answers before the entity is stored: no store has it yet, however it is read.
    if (published.length > 0) {
      const exposed = readOp.paths.filter((p) => exposingRead(p, entity, () => true, primed));
      if (exposed.length === 0) {
        return passed(
          `A read right after a create finds it: ${writeOp.operation.label} fills ${[...primed].map((id) => labelOf(ctx, id)).join(", ")} before answering, and ${read.toLowerCase()} looks there first.`,
        );
      }
      return failedRead(
        params.readOperation,
        exposed,
        entity,
        `${read} can look for a new ${entity} before anything has stored it: ${write} answers once it has published the ${entity}, and a consumer stores it later`,
      );
    }

    const stores = new Set(
      stored.flatMap((p) =>
        p.steps.flatMap((s) => (s.kind === "call" && isCreate(s, entity) ? [s.target] : [])),
      ),
    );
    const mode = params.decision ? ctx.attempt.decisions[params.decision] : undefined;
    const components = ctx.attempt.architecture.components.filter((c) => stores.has(c.id));
    const reasons = new Map(
      components.flatMap((c) => {
        const reason = staleReadReason(c, ctx.catalog, mode);
        return reason === null ? [] : [[c.id, reason] as const];
      }),
    );
    if (reasons.size === 0) {
      const labels = components.map((c) => c.label).join(", ");
      return passed(
        `${labels} answer${components.length === 1 ? "s" : ""} every read with the latest acknowledged write.`,
      );
    }
    const lagging = (s: Extract<PathStep, { kind: "call" }>) =>
      reasons.has(s.target) && !s.consistent;
    const exposed = readOp.paths.filter((p) => exposingRead(p, entity, lagging, primed));
    if (exposed.length === 0) {
      const how =
        primed.size > 0
          ? `${writeOp.operation.label} fills ${[...primed].map((id) => labelOf(ctx, id)).join(", ")} before answering, and ${read.toLowerCase()} looks there first`
          : `${read} never answers "not found" from a copy that can lag`;
      return passed(`A read right after a create finds it: ${how}.`);
    }
    const step = exposingRead(exposed[0] as Path, entity, lagging, primed);
    const target = step?.target ?? "";
    return failedRead(
      params.readOperation,
      exposed,
      entity,
      `${read} can read ${labelOf(ctx, target)} within about ${ASYNC_REPLICATION_LAG_SEC} s of ${write} without seeing the new ${entity}: ${reasons.get(target)}`,
    );
  },
});

/** A finding for read paths that miss a fresh entity, with what their answer does. */
function failedRead(operation: string, exposed: readonly Path[], entity: string, why: string) {
  const status = pathStatus(exposed[0] as Path);
  const ttl = cachedMiss(exposed, entity);
  const answer = status === null ? "It finds nothing" : `It answers ${status}`;
  const kept =
    ttl === null ? "" : `, and the negative cache keeps that answer for ${duration(ttl)}`;
  const evidence: Evidence[] = exposed.map((p) => ({ type: "path", operation, pathId: p.id }));
  return failed(`${why}. ${answer}${kept}.`, evidence);
}

const isConditionalCreate = (step: PathStep, entity: string) =>
  step.kind === "call" &&
  step.outcome === "ok" &&
  step.entity === entity &&
  step.action === "store.insertIfAbsent";

/**
 * When both regions take creates, a code is unique only if one place checks
 * it. A store that takes writes in both regions (a DynamoDB global table in
 * its default mode) checks a conditional insert against its own region's
 * copy and keeps the last write: two creates of the same code within the
 * replication lag both succeed, and one overwrites the other. A store with
 * one primary, or a create sent to the home region, checks in one place.
 */
export const uniqueAcrossRegions = defineCheck({
  id: "unique-across-regions",
  description: "Codes stay unique when both regions take creates.",
  params: z.strictObject({
    operation: z.string().min(1),
    entity: z.string().min(1),
    /** Decision point that records whether both regions take traffic. */
    decision: z.string().min(1),
  }),
  run(params, ctx) {
    const op = ctx.analysis.operations.get(params.operation);
    if (!op) return notApplicable("The operation needs a flow.");
    if (ctx.attempt.decisions[params.decision] !== "active-active") {
      return notApplicable("Only one region takes creates.");
    }
    const entity = params.entity;
    const creates = op.paths.filter(
      (p) => servesResource(p) && p.steps.some((s) => isConditionalCreate(s, entity)),
    );
    if (creates.length === 0) return notApplicable(`Nothing checks a ${entity} before storing it.`);
    const component = (id: string) => ctx.attempt.architecture.components.find((c) => c.id === id);
    const callerOf = (s: Extract<PathStep, { kind: "call" }>) =>
      component(
        ctx.attempt.architecture.connections.find((c) => c.id === s.connectionId)?.from ?? "",
      );
    const checkedLocally = (s: PathStep) => {
      if (!isConditionalCreate(s, entity) || s.kind !== "call" || s.homeRegion) return false;
      const store = component(s.target);
      const caller = callerOf(s);
      if (!store || !caller) return false;
      return (
        hasStandby(caller, ctx.catalog) &&
        hasStandby(store, ctx.catalog) &&
        !singleWriter(store, ctx.catalog)
      );
    };
    // Where codes can clash: aliases people choose, or a key service in each region handing out the same ranges.
    const isAlias = (s: PathStep) =>
      s.kind === "logic" && s.logic === "hasCustomAlias" && s.outcome === "custom";
    const allocatesInBoth = (s: PathStep) => {
      if (s.kind !== "call" || (s.action !== "ids.allocate" && s.action !== "coord.leaseRange")) {
        return false;
      }
      const allocator = component(s.target);
      return allocator !== undefined && hasStandby(allocator, ctx.catalog);
    };
    const local = creates.filter((p) => p.steps.some(checkedLocally));
    const exposed = local.filter((p) => p.steps.some(isAlias) || p.steps.some(allocatesInBoth));
    if (exposed.length === 0) {
      const why =
        local.length > 0
          ? `the codes it checks in each region on their own are random, and two regions drawing the same one within a second is negligible`
          : "the store takes writes at one primary, or the create is sent to the home region";
      return passed(
        `Every ${op.operation.label.toLowerCase()} keeps its ${entity} unique: ${why}.`,
      );
    }
    const step = exposed[0]?.steps.find(checkedLocally);
    const store = step?.kind === "call" ? (component(step.target)?.label ?? step.target) : "";
    const aliases = exposed.some((p) => p.steps.some(isAlias));
    const clash = aliases
      ? "two people who ask for the same alias in different regions within about a second of each other both get it"
      : "the key service in each region hands out codes from the same ranges, and both regions store the same code";
    const evidence: Evidence[] = exposed.map((p) => ({
      type: "path",
      operation: params.operation,
      pathId: p.id,
    }));
    return failed(
      `Both regions take creates, and ${store} checks a new ${entity} against its own region's copy only, so ${clash}. The store keeps the last write: one ${entity} silently replaces the other.`,
      evidence,
    );
  },
});
