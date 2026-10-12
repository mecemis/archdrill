import { ACTIONS, type Attempt, LOGIC, type Step } from "@archdrill/model";
import { statusLabel } from "../../ui/outcome";

export function componentLabel(attempt: Attempt, id: string): string {
  return attempt.architecture.components.find((c) => c.id === id)?.label ?? id;
}

/** One-line description of a step, e.g. `Redis · get Link`. */
export function stepTitle(step: Step, attempt: Attempt): string {
  switch (step.type) {
    case "call": {
      const action = `${ACTIONS[step.action].label} ${step.entity ?? ""}`.trim();
      const ttl = step.ttlSec === undefined ? "" : ` (TTL ${step.ttlSec}s)`;
      return `${componentLabel(attempt, step.target)} · ${action}${ttl}`;
    }
    case "logic":
      return LOGIC[step.logic].label;
    case "respond":
      return `respond ${statusLabel(step.status)}`;
  }
}
