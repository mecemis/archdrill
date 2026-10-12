import { z } from "zod";
import type { Evidence } from "../evidence";
import { evalPredicate, PathPredicateSchema } from "../predicates";
import { pathEvidence } from "./paths";
import { defineCheck, failed, notApplicable } from "./types";

const StrategySchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Paths implementing this strategy satisfy this predicate. */
  where: PathPredicateSchema,
  /** What an interviewer would want to hear about this approach. */
  note: z.string().min(1),
});

/**
 * Recognises which of several valid approaches a flow implements, from the
 * paths in scope. Several designs can be right: the check names the one it
 * sees, compares it with the candidate's declared decision, and gives partial
 * credit (not zero) when it recognises none, because outcome checks still
 * judge whether the unfamiliar approach works.
 */
export const recognizeStrategy = defineCheck({
  id: "recognize-strategy",
  description: "Names the approach a flow implements and compares it with the declared decision.",
  params: z.strictObject({
    operation: z.string().min(1),
    /** Which paths must follow a recognisable strategy. */
    scope: PathPredicateSchema,
    /** Decision point whose chosen option should match the recognised strategy id. */
    decision: z.string().min(1).optional(),
    strategies: z.array(StrategySchema).min(1),
  }),
  run(params, ctx) {
    const op = ctx.analysis.operations.get(params.operation);
    const inScope = op?.paths.filter((p) => evalPredicate(p, params.scope, op.operation)) ?? [];
    if (!op || inScope.length === 0) return notApplicable("No path is in scope for this approach.");
    const fits = params.strategies.filter((s) =>
      inScope.every((p) => evalPredicate(p, s.where, op.operation)),
    );
    const recognised = fits[0];
    if (!recognised) {
      const unmatched = inScope.filter(
        (p) => !params.strategies.some((s) => evalPredicate(p, s.where, op.operation)),
      );
      const { evidence, details } = pathEvidence(unmatched.length > 0 ? unmatched : inScope);
      return {
        status: "partial",
        fraction: 0.5,
        message:
          unmatched.length > 0
            ? "The approach was not recognised. If it is sound, the outcome checks will show it; consider recording it for review."
            : "Different paths follow different approaches; pick one so behaviour is predictable.",
        details,
        evidence,
        data: { strategy: "unrecognised" },
      };
    }
    const data = { strategy: recognised.id, label: recognised.label };
    const chosen = params.decision ? ctx.attempt.decisions[params.decision] : undefined;
    if (chosen !== undefined && !fits.some((s) => s.id === chosen)) {
      const point = ctx.problem.decisionPoints.find((d) => d.id === params.decision);
      const chosenLabel = point?.options.find((o) => o.id === chosen)?.label ?? chosen;
      const evidence: Evidence[] = inScope.map((p) => ({
        type: "path",
        operation: p.operation,
        pathId: p.id,
      }));
      return {
        ...failed(
          `You chose "${chosenLabel}", but the flow implements ${recognised.label.toLowerCase()}.`,
          evidence,
        ),
        data,
      };
    }
    return {
      status: "pass",
      fraction: 1,
      message: `Recognised: ${recognised.label}. ${recognised.note}`,
      details: [],
      evidence: [],
      data,
    };
  },
});
