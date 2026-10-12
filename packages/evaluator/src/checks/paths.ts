import { describePath, type Path } from "@archdrill/engine";
import { feasibleOutcomes, reachableStepIds } from "@archdrill/model";
import { z } from "zod";
import type { Evidence } from "../evidence";
import {
  evalPredicate,
  isSuccessPath,
  matchStep,
  PathPredicateSchema,
  StepMatcherSchema,
} from "../predicates";
import {
  defineCheck,
  failed,
  graded,
  MAX_DETAIL_LINES,
  notApplicable,
  passed,
  requireOperation,
} from "./types";

const OperationParam = z.string().min(1);

export function pathEvidence(paths: readonly Path[]): { evidence: Evidence[]; details: string[] } {
  return {
    evidence: paths.map((p) => ({ type: "path", operation: p.operation, pathId: p.id })),
    details: paths.slice(0, MAX_DETAIL_LINES).map((p) => `#${p.index} ${describePath(p)}`),
  };
}

function countPaths(n: number): string {
  return n === 1 ? "1 path" : `${n} paths`;
}

/** Every step that can produce the outcome (optionally narrowed by a matcher) leads somewhere. */
export const outcomeHandled = defineCheck({
  id: "outcome-handled",
  description: "Every step that can produce the given outcome handles it explicitly.",
  params: z.strictObject({
    operation: OperationParam,
    outcome: z.string().min(1),
    match: StepMatcherSchema.omit({ outcome: true }).optional(),
  }),
  run(params, ctx) {
    const op = requireOperation(ctx, params.operation);
    const flow = op.flow;
    if (!flow) return notApplicable(`"${params.operation}" has no flow yet.`);
    const relevant = reachableStepIds(flow).filter((stepId) => {
      const step = flow.steps[stepId];
      if (
        !step ||
        step.type === "respond" ||
        !feasibleOutcomes(step, ctx.attempt).includes(params.outcome)
      )
        return false;
      if (!params.match) return true;
      const probe =
        step.type === "call"
          ? {
              kind: "call" as const,
              stepId,
              target: step.target,
              connectionId: null,
              action: step.action,
              entity: step.entity,
              ttlSec: step.ttlSec,
              outcome: params.outcome,
            }
          : { kind: "logic" as const, stepId, logic: step.logic, outcome: params.outcome };
      return matchStep(probe, params.match);
    });
    if (relevant.length === 0)
      return notApplicable(`No step in "${params.operation}" can produce "${params.outcome}".`);
    const unhandled = relevant.filter((stepId) => {
      const step = flow.steps[stepId];
      return step?.type !== "respond" && step?.next[params.outcome] === undefined;
    });
    const evidence: Evidence[] = unhandled.map((stepId) => ({
      type: "step",
      operation: params.operation,
      stepId,
      outcome: params.outcome,
    }));
    const message =
      unhandled.length === 0
        ? `All ${relevant.length} step(s) handle "${params.outcome}".`
        : `${unhandled.length} of ${relevant.length} step(s) leave "${params.outcome}" unhandled.`;
    return graded(relevant.length - unhandled.length, relevant.length, message, evidence);
  },
});

/** No path of the operation may satisfy the predicate. */
export const noPath = defineCheck({
  id: "no-path",
  description: "No path of the operation satisfies the given condition.",
  params: z.strictObject({ operation: OperationParam, where: PathPredicateSchema }),
  run(params, ctx) {
    const op = requireOperation(ctx, params.operation);
    const matching = op.paths.filter((p) => evalPredicate(p, params.where, op.operation));
    if (matching.length === 0) return passed(`None of the ${op.paths.length} paths match.`);
    const { evidence, details } = pathEvidence(matching);
    return failed(`${countPaths(matching.length)} match.`, evidence, details);
  },
});

/** Every path ending in a success status (or the given statuses) contains a matching step. */
export const allSuccessPathsContain = defineCheck({
  id: "all-success-paths-contain",
  description: "Every successful path contains a step matching the description.",
  params: z.strictObject({
    operation: OperationParam,
    step: StepMatcherSchema,
    statuses: z.array(z.number().int()).min(1).optional(),
  }),
  run(params, ctx) {
    const op = requireOperation(ctx, params.operation);
    const inScope = op.paths.filter((p) =>
      params.statuses
        ? p.terminal.kind === "respond" && params.statuses.includes(p.terminal.status)
        : isSuccessPath(p, op.operation),
    );
    if (inScope.length === 0)
      return notApplicable("No path ends with one of the statuses in scope.");
    const missing = inScope.filter((p) => !p.steps.some((s) => matchStep(s, params.step)));
    if (missing.length === 0)
      return passed(`All ${countPaths(inScope.length)} in scope contain the step.`);
    const { evidence, details } = pathEvidence(missing);
    return failed(
      `${countPaths(missing.length)} of ${inScope.length} lack the step.`,
      evidence,
      details,
    );
  },
});

/** Every path that satisfies `when` ends with one of the given statuses. */
export const statusForCondition = defineCheck({
  id: "status-for-condition",
  description: "Paths that satisfy a condition end with one of the expected statuses.",
  params: z.strictObject({
    operation: OperationParam,
    when: PathPredicateSchema,
    statuses: z.array(z.number().int()).min(1),
  }),
  run(params, ctx) {
    const op = requireOperation(ctx, params.operation);
    const inScope = op.paths.filter((p) => evalPredicate(p, params.when, op.operation));
    if (inScope.length === 0) return notApplicable("No path reaches this condition.");
    const wrong = inScope.filter(
      (p) => p.terminal.kind !== "respond" || !params.statuses.includes(p.terminal.status),
    );
    const expected = params.statuses.join(" or ");
    if (wrong.length === 0) return passed(`All ${countPaths(inScope.length)} answer ${expected}.`);
    const { evidence, details } = pathEvidence(wrong);
    return failed(
      `${countPaths(wrong.length)} of ${inScope.length} do not answer ${expected}.`,
      evidence,
      details,
    );
  },
});
