import type { ActionId, Attempt, LogicId, Step, StepInput } from "@archdrill/model";
import { getLogic } from "@archdrill/model";
import { catalogIndex } from "../../state/content";
import { eventLabel, respondLabel } from "../../state/triggers";
import { componentLabel, stepTitle } from "./step-label";

/** Plain sentences for calls: {e} is the entity, {t} the component, {v} the event. */
const CALL_SENTENCES: Readonly<Record<ActionId, string>> = {
  "cache.get": "Look up {e} in {t}",
  "cache.set": "Save {e} in {t}",
  "cache.setNegative": "Remember in {t} that the {e} does not exist",
  "cache.delete": "Remove {e} from {t}",
  "store.read": "Read {e} from {t}",
  "store.insert": "Write {e} to {t}",
  "store.insertIfAbsent": "Write {e} to {t} if its key is free",
  "store.update": "Update {e} in {t}",
  "store.delete": "Delete {e} from {t}",
  "queue.publish": "Publish {v} to {t}",
  "counter.increment": "Count {e} in {t}",
  "service.call": "Call {t}",
  "connection.push": "Push {e} over {t}",
  "external.notify": "Send a notification through {t}",
  "external.charge": "Charge the card with {t}",
  "external.refund": "Refund the payment with {t}",
  "payments.lookup": "Look up the payment at {t}",
  "external.check": "Check the URL with {t}",
  "ids.allocate": "Get a new id from {t}",
  "coord.leaseRange": "Lease a range of ids from {t}",
};

/** Decisions whose label reads poorly as a sentence. */
const LOGIC_SENTENCES: Partial<Record<LogicId, string>> = {
  matchThreatList: "Match the URL against the local threat lists",
};

type AnyStep = Step | StepInput;

/** A URL check against an API that provides local lists confirms a match on them. */
function confirmsMatch(step: Extract<AnyStep, { type: "call" }>, attempt: Attempt): boolean {
  if (step.action !== "external.check") return false;
  const target = attempt.architecture.components.find((c) => c.id === step.target);
  return (
    target !== undefined &&
    catalogIndex.capabilities(target.kind, target.flavor).has("threat-lists")
  );
}

/** What a step does, as a short sentence: "Read Link from PostgreSQL". */
export function stepSentence(step: AnyStep, attempt: Attempt, background = false): string {
  switch (step.type) {
    case "call": {
      const template = confirmsMatch(step, attempt)
        ? "Confirm the match with {t}"
        : CALL_SENTENCES[step.action];
      if (!template) return stepTitle({ ...step, next: {} } as Step, attempt, background);
      return template
        .replace("{e}", step.entity ?? "the data")
        .replace("{t}", componentLabel(attempt, step.target))
        .replace("{v}", step.event === undefined ? "the event" : eventLabel(step.event));
    }
    case "logic": {
      const sentence = LOGIC_SENTENCES[step.logic];
      if (sentence) return sentence;
      const label = getLogic(step.logic).label;
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
    case "respond":
      return background
        ? `Finish: ${respondLabel(step.status, true)}`
        : `Respond ${respondLabel(step.status, false)}`;
  }
}

/** Outcome names as people say them: "notFound" → "not found". */
export function outcomeLabel(outcome: string): string {
  return outcome.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}
