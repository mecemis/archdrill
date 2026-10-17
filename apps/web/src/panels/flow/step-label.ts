import { ACTIONS, type Attempt, LOGIC, type Step, type StepInput } from "@archdrill/model";
import { activePack } from "../../state/content";
import { eventLabel, respondLabel } from "../../state/triggers";

export function componentLabel(attempt: Attempt, id: string): string {
  return attempt.architecture.components.find((c) => c.id === id)?.label ?? id;
}

/**
 * One-line description of a step, e.g. `Redis · get Link`. In consumers and
 * jobs a final status says whether the item is done or will be tried again.
 */
/** A call's settings worth seeing at a glance: "TTL 3600s", "batch 1,000", "outbox"… */
export function stepDetails(step: Step | StepInput): string[] {
  if (step.type !== "call") return [];
  const details: string[] = [];
  if (step.each !== undefined) {
    const count = activePack.problem.counts.find((c) => c.id === step.each);
    details.push(`each of ${count?.label ?? step.each}`);
  }
  if (step.ttlSec !== undefined) details.push(`TTL ${step.ttlSec}s`);
  if (step.aggregateSec !== undefined) details.push(`per ${step.aggregateSec}s`);
  if (step.batchSize !== undefined) details.push(`batch ${step.batchSize.toLocaleString("en-US")}`);
  if (step.counterShards !== undefined) details.push(`${step.counterShards} counter shards`);
  if (step.coalesce) details.push("coalesced");
  if (step.consistent) details.push("consistent");
  if (step.homeRegion) details.push("home region");
  if (step.fireAndForget) details.push("fire-and-forget");
  else if (step.outbox) details.push("outbox");
  if (step.idempotencyKey) details.push("idempotency key");
  if (step.exactlyOnce) details.push("exactly once");
  return details;
}

export function stepTitle(step: Step, attempt: Attempt, background = false): string {
  switch (step.type) {
    case "call": {
      const about = step.event === undefined ? (step.entity ?? "") : eventLabel(step.event);
      const action = `${ACTIONS[step.action].label} ${about}`.trim();
      const details = stepDetails(step)
        .map((d) => ` (${d})`)
        .join("");
      return `${componentLabel(attempt, step.target)} · ${action}${details}`;
    }
    case "logic":
      return LOGIC[step.logic].label;
    case "respond":
      return background
        ? `finish: ${respondLabel(step.status, true)}`
        : `respond ${respondLabel(step.status, false)}`;
  }
}
