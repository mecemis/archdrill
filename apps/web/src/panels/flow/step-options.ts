import {
  ACTIONS,
  type ActionId,
  type Attempt,
  actionTakesEntity,
  actionTakesParam,
  type CatalogIndex,
  callableFrom,
  connectionToCall,
  type StepInput,
} from "@archdrill/model";
import { activePack } from "../../state/content";
import { stepSentence } from "./sentences";

/** A step one choice adds, said as a sentence. */
export interface Option {
  readonly key: string;
  readonly label: string;
  readonly step: StepInput;
}

/** What the handler can call on one component, and whether it is connected to it yet. */
export interface TargetOptions {
  readonly connected: boolean;
  readonly options: Option[];
}

/**
 * Every call the handler can make, by the component it calls: connected to
 * it or not (choosing a step connects it).
 */
export function callOptions(
  attempt: Attempt,
  handler: string,
  entity: string,
  catalog: CatalogIndex,
): Map<string, TargetOptions> {
  const byTarget = new Map<string, TargetOptions>();
  for (const id of callableFrom(handler, attempt, catalog)) {
    const target = attempt.architecture.components.find((c) => c.id === id);
    if (!target) continue;
    const options: Option[] = [];
    for (const action of Object.keys(ACTIONS) as ActionId[]) {
      const def = ACTIONS[action];
      if (!catalog.capabilities(target.kind, target.flavor).has(def.capability)) continue;
      const events = actionTakesParam(action, "event")
        ? activePack.problem.events.map((e) => e.id)
        : [undefined];
      for (const event of events) {
        const step: StepInput = {
          type: "call",
          target: target.id,
          action,
          ...(actionTakesEntity(action) ? { entity } : {}),
          ...(event !== undefined ? { event } : {}),
          ...(action === "cache.set" ? { ttlSec: 3600 } : {}),
          ...(action === "cache.setNegative" ? { ttlSec: 60 } : {}),
        };
        options.push({
          key: `call:${target.id}:${action}:${event ?? ""}`,
          label: stepSentence(step, attempt),
          step,
        });
      }
    }
    const connected = connectionToCall(handler, target.id, attempt, catalog).kind !== "add";
    if (options.length > 0) byTarget.set(target.id, { connected, options });
  }
  return byTarget;
}
