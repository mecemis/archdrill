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
  /** Share of the keyspace taken by custom aliases, which generated keys can still meet. */
  aliasOccupancy(entity: string | undefined): number;
}

/** Share of requests that make a batched allocation call: one per batch. */
export function batchShare(step: PathStep): number {
  return step.kind === "call" && step.batchSize ? 1 / step.batchSize : 1;
}

/**
 * Calls a path step makes per request on its path. A batched call that failed
 * was certainly made; otherwise about one request in a batch makes it (exact
 * when the target does not drop calls).
 */
export function callShare(step: PathStep): number {
  return step.kind === "call" && step.outcome === "error" ? 1 : batchShare(step);
}

/** Where the code a conditional insert writes came from, judging by the steps before it. */
type CodeOrigin = "custom" | "random" | "repeated-hash" | "unique" | "unknown";

const isAllocation = (step: PathStep) =>
  step.kind === "call" && (step.action === "ids.allocate" || step.action === "coord.leaseRange");

function codeOrigin(prior: readonly PathStep[]): CodeOrigin {
  for (let i = prior.length - 1; i >= 0; i--) {
    const step = prior[i];
    if (!step) continue;
    if (isAllocation(step)) return "unique";
    if (step.kind !== "logic") continue;
    if (step.logic === "hasCustomAlias" && step.outcome === "custom") return "custom";
    if (step.logic === "generateRandomCode" || step.logic === "rehashWithSalt") return "random";
    if (step.logic === "hashUrl") return hashCollidedBefore(prior, i) ? "repeated-hash" : "random";
  }
  return "unknown";
}

/**
 * Whether the URL was already hashed earlier on the path and that code
 * collided: hashing the same URL again without a salt gives the same code.
 */
function hashCollidedBefore(prior: readonly PathStep[], hashIndex: number): boolean {
  let collided = false;
  for (let i = hashIndex - 1; i >= 0; i--) {
    const step = prior[i];
    if (!step) continue;
    if (
      step.kind === "call" &&
      step.action === "store.insertIfAbsent" &&
      step.outcome === "conflict"
    )
      collided = true;
    if (step.kind === "logic" && step.logic === "hashUrl") return collided;
    if (
      step.kind === "logic" &&
      (step.logic === "generateRandomCode" || step.logic === "rehashWithSalt")
    )
      return false;
    if (isAllocation(step)) return false;
  }
  return false;
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
    case "repeated-hash":
      return 1;
    case "unique":
      // Unique among generated keys, but a custom alias may already hold the code.
      return state.aliasOccupancy(entity);
    default:
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
  // A batched call is only made once per batch, so only then can it be rejected.
  const drop = state.dropRate(step.target) * batchShare(step);
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
    case "rehashWithSalt":
    case "encodeBase62":
    case "obfuscateId":
      return outcome === "ok" ? 1 : 0;
    default:
      return 0;
  }
}
