import type { Path, PathStep } from "@archdrill/engine";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { servesResource } from "../predicates";
import { pathEvidence } from "./paths";
import { defineCheck, graded, notApplicable, requireOperation } from "./types";

const isCacheMiss = (step: PathStep, entity: string) =>
  step.kind === "call" &&
  step.action === "cache.get" &&
  step.entity === entity &&
  step.outcome === "miss";

const isStoreFound = (step: PathStep, entity: string) =>
  step.kind === "call" &&
  step.action === "store.read" &&
  step.entity === entity &&
  step.outcome === "found";

const isPopulate = (step: PathStep, entity: string) =>
  step.kind === "call" && step.action === "cache.set" && step.entity === entity;

/**
 * On paths that miss the cache, find the entity in the store and serve it, the
 * cache is populated afterwards. Otherwise the cache never warms.
 */
export const populateAfterMiss = defineCheck({
  id: "populate-after-miss",
  description: "After a cache miss is served from the store, the cache is populated.",
  params: z.strictObject({ operation: z.string().min(1), entity: z.string().min(1) }),
  run(params, ctx) {
    const op = requireOperation(ctx, params.operation);
    const relevant: { path: Path; readIndex: number }[] = [];
    for (const path of op.paths) {
      if (!servesResource(path)) continue;
      const missIndex = path.steps.findIndex((s) => isCacheMiss(s, params.entity));
      if (missIndex < 0) continue;
      const readIndex = path.steps.findIndex(
        (s, i) => i > missIndex && isStoreFound(s, params.entity),
      );
      if (readIndex >= 0) relevant.push({ path, readIndex });
    }
    if (relevant.length === 0) {
      return notApplicable(`No path reads ${params.entity} from the store after a cache miss.`);
    }
    const missing = relevant.filter(
      ({ path, readIndex }) =>
        !path.steps.some((s, i) => i > readIndex && isPopulate(s, params.entity)),
    );
    const { evidence: pathEv, details } = pathEvidence(missing.map((m) => m.path));
    const stepEv: Evidence[] = [
      ...new Set(missing.map(({ path, readIndex }) => path.steps[readIndex]?.stepId ?? "")),
    ]
      .filter((id) => id !== "")
      .map((stepId) => ({ type: "step", operation: params.operation, stepId }));
    const message =
      missing.length === 0
        ? `All ${relevant.length} miss-then-found path(s) populate the cache.`
        : `${missing.length} of ${relevant.length} miss-then-found path(s) never populate the cache.`;
    return graded(
      relevant.length - missing.length,
      relevant.length,
      message,
      [...stepEv, ...pathEv],
      details,
    );
  },
});
