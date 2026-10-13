import type { CallPathStep, LogicPathStep, Path } from "@archdrill/engine";
import { z } from "zod";
import { pathEvidence } from "./paths";
import {
  type CheckContext,
  defineCheck,
  failed,
  notApplicable,
  passed,
  requireOperation,
} from "./types";

const DECISIONS = new Set(["checkLimit", "checkLocalLimit"]);

function inProcess(ctx: CheckContext, componentId: string): boolean {
  const component = ctx.attempt.architecture.components.find((c) => c.id === componentId);
  return component ? ctx.catalog.kind(component.kind)?.inProcess === true : false;
}

/** Why an allowed path's limit does not hold across the fleet, or null if it does. */
function leak(ctx: CheckContext, path: Path, entity: string): string | null {
  const decisions = path.steps.filter(
    (s): s is LogicPathStep =>
      s.kind === "logic" && DECISIONS.has(s.logic) && s.outcome === "under",
  );
  const decision = decisions.at(-1);
  if (!decision) return null;
  const before = path.steps.slice(0, path.steps.indexOf(decision));
  const counts = before.filter(
    (s): s is CallPathStep =>
      s.kind === "call" && s.action === "counter.increment" && s.entity === entity,
  );
  const sharedFailed = counts.some((s) => !inProcess(ctx, s.target) && s.outcome === "error");
  if (decision.logic === "checkLocalLimit") {
    return sharedFailed ? null : "decides on one server's count while the shared count works";
  }
  const last = counts.at(-1);
  if (!last) return "checks the limit without counting the request";
  if (inProcess(ctx, last.target))
    return "counts on each server, so every server allows the full limit";
  if (last.outcome === "error") return "checks the limit against a count that failed";
  return null;
}

/**
 * A limit holds only if the count it is checked against covers every
 * server: allowed requests are counted in a shared store. Counting on one
 * server is acceptable only as a fallback while the shared count fails.
 */
export const limitsAreGlobal = defineCheck({
  id: "limits-are-global",
  description:
    "Allowed requests are checked against a count shared by every server, falling back to a server's own count only while the shared count fails.",
  params: z.strictObject({ operation: z.string().min(1), entity: z.string().min(1) }),
  run(params, ctx) {
    const op = requireOperation(ctx, params.operation);
    const checked = op.paths
      .map((path) => ({ path, why: leak(ctx, path, params.entity) }))
      .filter(({ path }) =>
        path.steps.some(
          (s) => s.kind === "logic" && DECISIONS.has(s.logic) && s.outcome === "under",
        ),
      );
    if (checked.length === 0) return notApplicable("No path checks a limit.");
    const leaking = checked.filter((c) => c.why !== null);
    if (leaking.length === 0) {
      return passed("Every allowed request is checked against a count shared by the whole fleet.");
    }
    const { evidence, details } = pathEvidence(leaking.map((c) => c.path));
    const reasons = [...new Set(leaking.map((c) => c.why))].join("; ");
    return failed(
      `${leaking.length} of ${checked.length} allowed paths do not enforce a fleet-wide limit: the flow ${reasons}. With hundreds of servers, a client gets hundreds of times its limit.`,
      evidence,
      details,
    );
  },
});
