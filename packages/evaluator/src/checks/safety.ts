import type { Path } from "@archdrill/engine";
import { ACTIONS } from "@archdrill/model";
import { z } from "zod";
import { evalPredicate, isSuccessPath, pathStatus } from "../predicates";
import { pathEvidence } from "./paths";
import { type CheckContext, defineCheck, failed, passed, requireOperation } from "./types";

/** A successful path that stores a new entity and answers 2xx. */
function accepts(path: Path, entity: string): boolean {
  const status = pathStatus(path);
  if (status === null || status < 200 || status >= 300) return false;
  return path.steps.some(
    (s) =>
      s.kind === "call" &&
      s.entity === entity &&
      s.outcome === "ok" &&
      ACTIONS[s.action].capability !== "volatile-kv" &&
      ["write", "conditional-write"].includes(ACTIONS[s.action].effect),
  );
}

const checkedClean = (path: Path) =>
  path.steps.some(
    (s) => s.kind === "call" && s.action === "external.check" && s.outcome === "clean",
  );

const publishedEvents = (path: Path) =>
  path.steps.flatMap((s) =>
    s.kind === "call" && s.action === "queue.publish" && s.outcome === "ok" && s.event
      ? [s.event]
      : [],
  );

/** Events with a consumer that disables the entity when the safety check flags it. */
function scannedEvents(ctx: CheckContext, entity: string): Map<string, string> {
  const scanned = new Map<string, string>();
  for (const analysis of ctx.analysis.operations.values()) {
    const trigger = analysis.operation.trigger;
    // Only a consumer that receives the event's messages scans anything.
    if (trigger.type !== "event" || analysis.status !== "ready" || !analysis.ingress) continue;
    const disables = analysis.paths.some(
      (path) =>
        isSuccessPath(path, analysis.operation) &&
        evalPredicate(
          path,
          {
            hasSequence: [
              { action: ["external.check"], outcome: ["malicious"] },
              { action: ["store.update"], entity, outcome: ["ok"] },
            ],
          },
          analysis.operation,
        ),
    );
    if (disables) scanned.set(trigger.event, analysis.operation.label);
  }
  return scanned;
}

/**
 * Content that a safety check would flag never stays live: every path that
 * stores it either checked it first, or published an event whose consumer
 * checks it and disables the entity.
 */
export const unsafeContentStopped = defineCheck({
  id: "unsafe-content-stopped",
  description:
    "Every path that stores new content checks it first, or hands it to a consumer that checks it and disables it if flagged.",
  params: z.strictObject({ operation: z.string().min(1), entity: z.string().min(1) }),
  run(params, ctx) {
    const op = requireOperation(ctx, params.operation);
    const accepting = op.paths.filter((p) => accepts(p, params.entity));
    if (accepting.length === 0) return passed(`No path stores a new ${params.entity}.`);
    const scanned = scannedEvents(ctx, params.entity);
    const later = (p: Path) => publishedEvents(p).some((e) => scanned.has(e));
    const unchecked = accepting.filter((p) => !checkedClean(p) && !later(p));
    if (unchecked.length === 0) {
      const consumers = [...new Set(accepting.flatMap(publishedEvents))]
        .map((e) => scanned.get(e))
        .filter((label): label is string => label !== undefined);
      const later = `${consumers.join(" and ")}, which disables it if flagged`;
      const how = accepting.every(checkedClean)
        ? "is checked before the create answers"
        : accepting.some(checkedClean)
          ? `is checked before the create answers, or else later by ${later}`
          : `is checked by ${later}`;
      return passed(`Every new ${params.entity} ${how}.`);
    }
    const { evidence, details } = pathEvidence(unchecked);
    const published = unchecked.some((p) => publishedEvents(p).length > 0);
    const hint = published
      ? " They publish an event, but no consumer of it disables a flagged link."
      : "";
    if (unchecked.length === accepting.length) {
      return failed(
        `Nothing checks the URL: a malicious ${params.entity} goes live and stays live.${hint}`,
        evidence,
        details,
      );
    }
    return {
      status: "partial",
      fraction: 1 - unchecked.length / accepting.length,
      message: `${unchecked.length} of ${accepting.length} paths store a ${params.entity} that was never checked, for example when the check fails.${hint}`,
      evidence,
      details,
    };
  },
});
