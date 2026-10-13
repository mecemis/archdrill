import type { CallPathStep, Path } from "@archdrill/engine";
import { ACTIONS } from "@archdrill/model";
import { z } from "zod";
import type { Evidence } from "../evidence";
import {
  type CheckContext,
  defineCheck,
  failed,
  MAX_DETAIL_LINES,
  notApplicable,
  passed,
  requireOperation,
} from "./types";

const WRITES = new Set(["write", "conditional-write", "delete", "increment"]);

function durable(ctx: CheckContext, componentId: string): boolean {
  const c = ctx.attempt.architecture.components.find((x) => x.id === componentId);
  return c ? ctx.catalog.capabilities(c.kind, c.flavor).has("durable-store") : false;
}

/** What is wrong with how a path publishes the event next to its store writes, if anything. */
function dualWrite(ctx: CheckContext, path: Path, event: string): string | null {
  const calls = path.steps.filter((s): s is CallPathStep => s.kind === "call");
  const at = calls.findIndex((s) => s.action === "queue.publish" && s.event === event);
  const publish = calls[at];
  if (!publish || publish.outbox) return null;
  const isWrite = (s: CallPathStep) =>
    WRITES.has(ACTIONS[s.action].effect) && durable(ctx, s.target) && s.outcome !== "error";
  if (calls.slice(at + 1).some(isWrite)) {
    return "publishes the event before the write it reports, which can still fail";
  }
  if (calls.slice(0, at).some(isWrite)) {
    return "publishes after the write has committed, so a failed publish loses the event while the write stays";
  }
  return null;
}

/**
 * A write and the event that reports it happen together or not at all. Two
 * separate calls cannot promise that; a transactional outbox writes the
 * event with the data and relays it afterwards.
 */
export const noDualWrite = defineCheck({
  id: "no-dual-write",
  description:
    "The event is published if and only if the write it reports commits: through a transactional outbox, not as a second call.",
  params: z.strictObject({ operation: z.string().min(1), event: z.string().min(1) }),
  run(params, ctx) {
    const op = requireOperation(ctx, params.operation);
    const event = ctx.problem.events.find((e) => e.id === params.event)?.label ?? params.event;
    const publishing = op.paths.filter((p) =>
      p.steps.some(
        (s) => s.kind === "call" && s.action === "queue.publish" && s.event === params.event,
      ),
    );
    if (publishing.length === 0) return notApplicable(`No path publishes ${event}.`);
    const wrong = publishing
      .map((path) => ({ path, why: dualWrite(ctx, path, params.event) }))
      .filter((w) => w.why !== null);
    if (wrong.length === 0) {
      return passed(`${event} is published through the transaction that writes the data.`);
    }
    const steps = new Map<string, CallPathStep>();
    for (const { path } of wrong) {
      for (const s of path.steps) {
        if (s.kind === "call" && s.action === "queue.publish" && s.event === params.event) {
          steps.set(s.stepId, s);
        }
      }
    }
    const evidence: Evidence[] = [...steps.values()].map((s) => ({
      type: "step",
      operation: params.operation,
      stepId: s.stepId,
    }));
    const reasons = [...new Set(wrong.map((w) => w.why))];
    return failed(
      `${op.operation.label} ${reasons.join("; it also ")}. The data and its event can disagree, and nothing ever reconciles them.`,
      evidence,
      wrong.slice(0, MAX_DETAIL_LINES).map(({ path }) => `#${path.index}`),
    );
  },
});
