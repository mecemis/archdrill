import type { Path } from "@archdrill/engine";
import type { Component } from "@archdrill/model";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { servesResource } from "../predicates";
import { type CheckContext, defineCheck, graded, notApplicable, passed } from "./types";

/**
 * A path survives the failure of a component when it never relies on that
 * component succeeding: it does not route through it, and every call to it on
 * the path takes the error outcome.
 */
function survivesFailureOf(path: Path, componentId: string, ingress: readonly string[]): boolean {
  if (ingress.includes(componentId)) return false;
  return path.steps.every(
    (step) => step.kind !== "call" || step.target !== componentId || step.outcome === "error",
  );
}

function isRedundant(component: Component, ctx: CheckContext): boolean {
  if (component.replicas >= 2) return true;
  return ctx.catalog.flavor(component.kind, component.flavor)?.managedRedundancy === true;
}

function isTrafficSource(component: Component, ctx: CheckContext): boolean {
  return ctx.catalog.capabilities(component.kind, component.flavor).has("traffic-source");
}

/**
 * Every component whose failure alone would stop the operation from serving
 * the resource must be redundant.
 */
export const noSinglePointOfFailure = defineCheck({
  id: "no-single-point-of-failure",
  description: "Every component the operation cannot survive losing is redundant.",
  params: z.strictObject({ operation: z.string().min(1) }),
  run(params, ctx) {
    const op = ctx.analysis.operations.get(params.operation);
    const serving = op?.paths.filter(servesResource) ?? [];
    if (!op || serving.length === 0) return notApplicable("No path serves the resource yet.");
    const ingress = op.ingress?.components ?? [];
    const touched = new Set(serving.flatMap((p) => p.components));
    const critical = ctx.attempt.architecture.components.filter(
      (c) =>
        touched.has(c.id) &&
        !isTrafficSource(c, ctx) &&
        !serving.some((p) => survivesFailureOf(p, c.id, ingress)),
    );
    if (critical.length === 0)
      return passed("The operation survives the loss of any single component.");
    const fragile = critical.filter((c) => !isRedundant(c, ctx));
    const evidence: Evidence[] = fragile.map((c) => ({ type: "component", componentId: c.id }));
    const message =
      fragile.length === 0
        ? `All ${critical.length} critical component(s) are redundant.`
        : `${fragile.map((c) => c.label).join(", ")} ${fragile.length === 1 ? "is a single point" : "are single points"} of failure.`;
    return graded(critical.length - fragile.length, critical.length, message, evidence);
  },
});

/** Components that no flow uses add cost and complexity without benefit. */
export const unusedComponents = defineCheck({
  id: "unused-components",
  description: "Every component is used by at least one operation.",
  params: z.strictObject({}),
  run(_params, ctx) {
    const unused = ctx.analysis.unusedComponents;
    const total = ctx.attempt.architecture.components.length;
    if (total === 0) return notApplicable("The design has no components yet.");
    const labels = unused.map(
      (id) => ctx.attempt.architecture.components.find((c) => c.id === id)?.label ?? id,
    );
    const message =
      unused.length === 0
        ? "Every component is used by a flow."
        : `${labels.join(", ")} ${unused.length === 1 ? "is" : "are"} not used by any flow.`;
    const evidence: Evidence[] = unused.map((componentId) => ({ type: "component", componentId }));
    return graded(total - unused.length, total, message, evidence);
  },
});
