import { CapabilitySchema } from "@archdrill/model";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { defineCheck, failed, notApplicable, passed } from "./types";

/** Requests of an operation pass through a component with the given capability on the way in. */
export const ingressHasCapability = defineCheck({
  id: "ingress-has-capability",
  description: "Requests pass a component with the capability before reaching the handler.",
  params: z.strictObject({ operation: z.string().min(1), capability: CapabilitySchema }),
  run(params, ctx) {
    const op = ctx.analysis.operations.get(params.operation);
    const route = op?.ingress?.components ?? [];
    if (!op?.flow || route.length === 0)
      return notApplicable("The operation has no ingress route yet.");
    const provider = ctx.attempt.architecture.components.find(
      (c) =>
        route.includes(c.id) && ctx.catalog.capabilities(c.kind, c.flavor).has(params.capability),
    );
    if (provider) return passed(`${provider.label} provides ${params.capability} on the way in.`);
    const evidence: Evidence[] = (op.ingress?.connections ?? []).map((connectionId) => ({
      type: "connection",
      connectionId,
    }));
    return failed(`Nothing on the ingress route provides ${params.capability}.`, evidence);
  },
});
