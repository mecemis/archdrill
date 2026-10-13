import { ACTIONS, type Attempt, LOGIC, type Step } from "@archdrill/model";
import { activePack } from "../../state/content";
import { eventLabel, respondLabel } from "../../state/triggers";

export function componentLabel(attempt: Attempt, id: string): string {
  return attempt.architecture.components.find((c) => c.id === id)?.label ?? id;
}

/**
 * One-line description of a step, e.g. `Redis · get Link`. In consumers and
 * jobs a final status says whether the item is done or will be tried again.
 */
export function stepTitle(step: Step, attempt: Attempt, background = false): string {
  switch (step.type) {
    case "call": {
      const about = step.event === undefined ? (step.entity ?? "") : eventLabel(step.event);
      const action = `${ACTIONS[step.action].label} ${about}`.trim();
      const ttl = step.ttlSec === undefined ? "" : ` (TTL ${step.ttlSec}s)`;
      const batch =
        step.batchSize === undefined ? "" : ` (batch ${step.batchSize.toLocaleString("en-US")})`;
      const coalesced = step.coalesce ? " (coalesced)" : "";
      const window = step.aggregateSec === undefined ? "" : ` (per ${step.aggregateSec}s)`;
      const spread =
        step.counterShards === undefined ? "" : ` (${step.counterShards} counter shards)`;
      const handoff = step.fireAndForget ? " (fire-and-forget)" : "";
      const fan =
        step.each === undefined
          ? ""
          : ` (each of ${activePack.problem.counts.find((c) => c.id === step.each)?.label ?? step.each})`;
      const details = `${fan}${ttl}${window}${batch}${spread}${coalesced}${handoff}`;
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
