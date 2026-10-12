import type { RequestClass } from "@archdrill/model";
import type { PathStep } from "../paths/types";

/** Model state the outcome probabilities depend on. */
export interface OutcomeState {
  /** Share of calls a component rejects because it is overloaded. */
  dropRate(componentId: string): number;
  hitRatio(componentId: string, entity: string | undefined): number;
  negativeHitRatio(componentId: string, entity: string | undefined): number;
  /** Chance that a randomly drawn code for this entity is already taken (stored / keyspace, capped at 1). */
  occupancy(entity: string | undefined): number;
}

/** Where the code a conditional insert writes came from, judging by the steps before it. */
type CodeOrigin = "custom" | "random" | "unique" | "unknown";

function codeOrigin(prior: readonly PathStep[]): CodeOrigin {
  for (let i = prior.length - 1; i >= 0; i--) {
    const step = prior[i];
    if (!step) continue;
    if (step.kind === "logic") {
      if (step.logic === "hasCustomAlias" && step.outcome === "custom") return "custom";
      if (step.logic === "generateRandomCode" || step.logic === "hashUrl") return "random";
    } else if (step.action === "ids.allocate" || step.action === "coord.leaseRange") {
      return "unique";
    }
  }
  return "unknown";
}

function conflictProbability(
  prior: readonly PathStep[],
  cls: RequestClass,
  state: OutcomeState,
  entity: string | undefined,
): number {
  switch (codeOrigin(prior)) {
    case "custom":
      return cls.aliasTaken ? 1 : 0;
    case "random":
      return state.occupancy(entity);
    default:
      // Keys from a generator or a counter range are unique by construction.
      return 0;
  }
}

/**
 * Probability that a step produces the outcome it takes on this path, for a
 * request of the given class. Outcomes of one step always sum to 1 over the
 * outcomes the design makes feasible.
 */
export function outcomeProbability(
  step: PathStep,
  cls: RequestClass,
  state: OutcomeState,
  prior: readonly PathStep[] = [],
): number {
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
    case "store.insertIfAbsent": {
      const conflict = conflictProbability(prior, cls, state, step.entity);
      if (step.outcome === "conflict") return served * conflict;
      return step.outcome === "ok" ? served * (1 - conflict) : 0;
    }
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
    case "hasCustomAlias":
      return (outcome === "custom") === cls.customAlias ? 1 : 0;
    case "generateRandomCode":
    case "hashUrl":
    case "encodeBase62":
    case "obfuscateId":
      return outcome === "ok" ? 1 : 0;
    default:
      return 0;
  }
}
