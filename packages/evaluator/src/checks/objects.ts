import { getLogic, onlyServesObjects } from "@archdrill/model";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { isSuccessPath, matchStep } from "../predicates";
import { pathEvidence } from "./paths";
import { defineCheck, failed, graded, notApplicable, passed } from "./types";

const SIGN = "signUpload";

/**
 * Clients that write straight to object storage carry a URL the service
 * signed: without one, the storage takes anyone's objects under any key.
 */
export const directWritesSigned = defineCheck({
  id: "direct-writes-signed",
  description:
    "When clients write straight to object storage, every success path of the operation that hands out upload URLs signs one.",
  params: z.strictObject({ operation: z.string().min(1), signedBy: z.string().min(1) }),
  run(params, ctx) {
    const op = ctx.analysis.operations.get(params.operation);
    if (!op?.flow) return notApplicable(`"${params.operation}" has no flow yet.`);
    const handler = ctx.attempt.architecture.components.find((c) => c.id === op.flow?.handler);
    if (!handler || !onlyServesObjects(ctx.catalog.capabilities(handler.kind, handler.flavor))) {
      return notApplicable(
        `${op.operation.label} goes through ${handler?.label ?? "a service"}, which checks who sends it.`,
      );
    }
    const evidence: Evidence[] = [{ type: "component", componentId: handler.id }];
    const signer = ctx.analysis.operations.get(params.signedBy);
    const succeeding = (signer?.paths ?? []).filter((p) =>
      isSuccessPath(p, signer?.operation ?? op.operation),
    );
    if (!signer?.flow || succeeding.length === 0) {
      return failed(
        `${handler.label} takes ${op.operation.label.toLowerCase()} straight from clients, but nothing hands out signed upload URLs: anyone could write to it.`,
        evidence,
      );
    }
    const unsigned = succeeding.filter(
      (p) => !p.steps.some((step) => matchStep(step, { logic: [SIGN] })),
    );
    if (unsigned.length === 0) {
      return passed(
        `${signer.operation.label} signs every upload URL (${getLogic(SIGN).label}); ${handler.label} checks the signature.`,
      );
    }
    const shown = pathEvidence(unsigned);
    return graded(
      succeeding.length - unsigned.length,
      succeeding.length,
      `${signer.operation.label} answers without signing on ${unsigned.length} of ${succeeding.length} successful paths: those clients could write anything to ${handler.label}, so anyone could.`,
      [...evidence, ...shown.evidence],
      shown.details,
    );
  },
});

/** Data the design must not lose lives in a durable store, not only in a cache. */
export const entityDurable = defineCheck({
  id: "entity-durable",
  description: "A durable store keeps the entity.",
  params: z.strictObject({ entity: z.string().min(1) }),
  run(params, ctx) {
    const holders = ctx.attempt.architecture.components.filter((c) =>
      c.data.some((d) => d.entity === params.entity),
    );
    const durable = holders.filter((c) =>
      ctx.catalog.capabilities(c.kind, c.flavor).has("durable-store"),
    );
    if (durable.length > 0) {
      return passed(`${durable.map((c) => c.label).join(" and ")} keep ${params.entity}.`);
    }
    if (holders.length === 0) {
      return failed(
        `Nothing keeps ${params.entity}: bind it to the store that holds it, or it is lost the moment it is written.`,
        [],
      );
    }
    return failed(
      `${params.entity} lives only in ${holders.map((c) => c.label).join(" and ")}, which can lose it at any time.`,
      holders.map((c) => ({ type: "component", componentId: c.id })),
    );
  },
});
