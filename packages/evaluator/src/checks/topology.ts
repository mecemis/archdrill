import { type Path, zoneLoss } from "@archdrill/engine";
import { type Component, LOGIC } from "@archdrill/model";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { servesResource } from "../predicates";
import { type CheckContext, defineCheck, failed, graded, notApplicable, passed } from "./types";

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

/**
 * The kind of request a path serves, read from the outcomes of branching
 * logic (custom alias or generated code, valid or expired): those depend on
 * the request, not on the infrastructure. Paths of the same kind are
 * alternatives for each other.
 */
function requestKind(path: Path): string {
  return path.steps
    .filter((step) => step.kind === "logic" && LOGIC[step.logic].outcomes.length > 1)
    .map((step) => `${step.kind === "logic" ? step.logic : ""}:${step.outcome}`)
    .join(",");
}

function isRedundant(component: Component, ctx: CheckContext): boolean {
  if (component.replicas >= 2) return true;
  return ctx.catalog.flavor(component.kind, component.flavor)?.managedRedundancy === true;
}

/** What a single failure is: one component, or an availability zone with every instance in it. */
const FailureScopeSchema = z.enum(["component", "zone"]).default("component");

function isTrafficSource(component: Component, ctx: CheckContext): boolean {
  return ctx.catalog.capabilities(component.kind, component.flavor).has("traffic-source");
}

/**
 * Every component whose failure alone would stop the operation from serving
 * the resource must be redundant: have a second instance, or, when the
 * failure is a lost zone, keep every key with the instances in other zones.
 */
export const noSinglePointOfFailure = defineCheck({
  id: "no-single-point-of-failure",
  description: "Every component the operation cannot survive losing is redundant.",
  params: z.strictObject({ operation: z.string().min(1), scope: FailureScopeSchema }),
  run(params, ctx) {
    const op = ctx.analysis.operations.get(params.operation);
    const serving = op?.paths.filter(servesResource) ?? [];
    if (!op || serving.length === 0) return notApplicable("No path serves the resource yet.");
    const ingress = op.ingress?.components ?? [];
    const byKind = new Map<string, Path[]>();
    for (const path of serving) {
      const key = requestKind(path);
      byKind.set(key, [...(byKind.get(key) ?? []), path]);
    }
    if (params.scope === "zone") return zoneVerdict([...byKind.values()], ingress, ctx);
    // A component is critical when some kind of request that succeeds today has
    // no successful path left without it.
    const critical = ctx.attempt.architecture.components.filter(
      (c) =>
        !isTrafficSource(c, ctx) &&
        [...byKind.values()].some(
          (paths) =>
            paths.some((p) => p.components.includes(c.id)) &&
            !paths.some((p) => survivesFailureOf(p, c.id, ingress)),
        ),
    );
    if (critical.length === 0)
      return passed("The operation survives the loss of any single component.");
    const fragile = critical.filter((c) => !isRedundant(c, ctx));
    if (fragile.length === 0)
      return passed(`All ${critical.length} critical component(s) are redundant.`);
    const evidence: Evidence[] = fragile.map((c) => ({ type: "component", componentId: c.id }));
    const labels = fragile.map((c) => c.label).join(", ");
    const verb = fragile.length === 1 ? "is a single point" : "are single points";
    return failed(`${labels} ${verb} of failure.`, evidence);
  },
});

/**
 * A lost zone takes every component that runs entirely in it at once, so
 * each kind of request needs a successful path that survives all of them
 * together. The finding names the lost components such requests use.
 */
function zoneVerdict(kinds: readonly Path[][], ingress: readonly string[], ctx: CheckContext) {
  const lost = ctx.attempt.architecture.components.flatMap((component) => {
    const loss = zoneLoss(component, ctx.catalog);
    return loss.keepsServing ? [] : [{ component, label: loss.label }];
  });
  const survives = (path: Path) =>
    lost.every(({ component }) => survivesFailureOf(path, component.id, ingress));
  const stranded = kinds.filter((paths) => !paths.some(survives));
  if (stranded.length === 0) {
    return passed("Every kind of request keeps a way to succeed when a zone is lost.");
  }
  const used = new Set(stranded.flatMap((paths) => paths.flatMap((p) => p.components)));
  const culprits = lost.filter(
    ({ component }) => used.has(component.id) || ingress.includes(component.id),
  );
  const evidence: Evidence[] = culprits.map(({ component }) => ({
    type: "component",
    componentId: component.id,
  }));
  const reasons = culprits
    .map(({ component, label }) => `${component.label} (${label})`)
    .join("; ");
  return failed(`Losing an availability zone takes down ${reasons}.`, evidence);
}

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
