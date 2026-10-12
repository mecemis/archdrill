import type { RequestClass } from "@archdrill/model";
import type { PathStep } from "../paths/types";

/** Model state the outcome probabilities depend on. */
export interface OutcomeState {
  /** Share of calls a component rejects because it is overloaded. */
  dropRate(componentId: string): number;
  hitRatio(componentId: string, entity: string | undefined): number;
  negativeHitRatio(componentId: string, entity: string | undefined): number;
}

/**
 * Probability that a step produces the outcome it takes on this path, for a
 * request of the given class. Outcomes of one step always sum to 1 over the
 * outcomes the design makes feasible.
 */
export function outcomeProbability(step: PathStep, cls: RequestClass, state: OutcomeState): number {
  if (step.kind === "logic") return logicProbability(step.logic, step.outcome, cls);
  const drop = state.dropRate(step.target);
  if (step.outcome === "error") return drop;
  const served = 1 - drop;
  switch (step.action) {
    case "cache.get": {
      if (cls.exists) {
        const hit = state.hitRatio(step.target, step.entity);
        if (step.outcome === "hit") return served * hit;
        if (step.outcome === "miss") return served * (1 - hit);
        return 0;
      }
      const negative = state.negativeHitRatio(step.target, step.entity);
      if (step.outcome === "negativeHit") return served * negative;
      if (step.outcome === "miss") return served * (1 - negative);
      return 0;
    }
    case "store.read":
      if (step.outcome === "found") return cls.exists ? served : 0;
      if (step.outcome === "notFound") return cls.exists ? 0 : served;
      return 0;
    case "store.update":
      if (step.outcome === "ok") return cls.exists ? served : 0;
      if (step.outcome === "notFound") return cls.exists ? 0 : served;
      return 0;
    case "store.insertIfAbsent":
      // Collision rates arrive with the write path (M3); until then inserts never conflict.
      return step.outcome === "ok" ? served : 0;
    default:
      return step.outcome === "ok" ? served : 0;
  }
}

function logicProbability(logic: string, outcome: string, cls: RequestClass): number {
  switch (logic) {
    case "checkExpiry":
      return (outcome === "expired") === cls.expired ? 1 : 0;
    case "checkStatus":
      return (outcome === "disabled") === cls.disabled ? 1 : 0;
    case "validateUrl":
      return (outcome === "invalid") === cls.invalidInput ? 1 : 0;
    default:
      return 0;
  }
}
