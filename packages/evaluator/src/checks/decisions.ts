import { z } from "zod";
import type { Evidence } from "../evidence";
import { defineCheck, failed, notApplicable, passed } from "./types";

/**
 * A decision avoids options that contradict the requirements, optionally
 * only when another decision went a certain way.
 */
export const decisionExcludes = defineCheck({
  id: "decision-excludes",
  description: "A decision avoids options that contradict the requirements.",
  params: z.strictObject({
    decision: z.string().min(1),
    forbidden: z
      .array(z.strictObject({ option: z.string().min(1), reason: z.string().min(1) }))
      .min(1),
    /** Applies only when this other decision chose one of these options. */
    when: z
      .strictObject({ decision: z.string().min(1), options: z.array(z.string().min(1)).min(1) })
      .optional(),
  }),
  run(params, ctx) {
    const labelOf = (decision: string, id: string) =>
      ctx.problem.decisionPoints.find((d) => d.id === decision)?.options.find((o) => o.id === id)
        ?.label ?? id;
    if (params.when) {
      const other = ctx.attempt.decisions[params.when.decision];
      if (other === undefined || !params.when.options.includes(other)) {
        return notApplicable("Does not apply to the decisions you made.");
      }
    }
    const point = ctx.problem.decisionPoints.find((d) => d.id === params.decision);
    const chosen = ctx.attempt.decisions[params.decision];
    const optionLabel = (id: string) => labelOf(params.decision, id);
    const evidence: Evidence[] = [
      { type: "decision", decision: params.decision },
      ...(params.when ? [{ type: "decision" as const, decision: params.when.decision }] : []),
    ];
    if (chosen === undefined) {
      return {
        status: "partial",
        fraction: 0.5,
        message: `Not decided yet: ${point?.question ?? params.decision} Record it under Decisions.`,
        details: [],
        evidence,
      };
    }
    const conflict = params.forbidden.find((f) => f.option === chosen);
    if (conflict) {
      const given = params.when
        ? ` together with "${labelOf(params.when.decision, ctx.attempt.decisions[params.when.decision] ?? "")}"`
        : "";
      return failed(`You chose "${optionLabel(chosen)}"${given}: ${conflict.reason}`, evidence);
    }
    return passed(`"${optionLabel(chosen)}" is consistent with the requirements.`);
  },
});
