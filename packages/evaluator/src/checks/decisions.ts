import { z } from "zod";
import { defineCheck, failed, passed } from "./types";

/** A decision avoids options that contradict the requirements. */
export const decisionExcludes = defineCheck({
  id: "decision-excludes",
  description: "A decision avoids options that contradict the requirements.",
  params: z.strictObject({
    decision: z.string().min(1),
    forbidden: z
      .array(z.strictObject({ option: z.string().min(1), reason: z.string().min(1) }))
      .min(1),
  }),
  run(params, ctx) {
    const point = ctx.problem.decisionPoints.find((d) => d.id === params.decision);
    const chosen = ctx.attempt.decisions[params.decision];
    const optionLabel = (id: string) => point?.options.find((o) => o.id === id)?.label ?? id;
    if (chosen === undefined) {
      return {
        status: "partial",
        fraction: 0.5,
        message: `Not decided yet: ${point?.question ?? params.decision} Record it under Decisions.`,
        details: [],
        evidence: [],
      };
    }
    const conflict = params.forbidden.find((f) => f.option === chosen);
    if (conflict) return failed(`You chose "${optionLabel(chosen)}": ${conflict.reason}`, []);
    return passed(`"${optionLabel(chosen)}" is consistent with the requirements.`);
  },
});
