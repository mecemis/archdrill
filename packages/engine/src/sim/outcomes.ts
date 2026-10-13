import {
  ACTIONS,
  getAction,
  hasFact,
  LOGIC,
  type LogicDef,
  type LogicId,
  type RequestClass,
} from "@archdrill/model";
import type { CallPathStep, PathStep } from "../paths/types";

/** Requests sent again with the same key: a conditional insert finds their first copy. */
export const DUPLICATE_FACT = "duplicate";

/** Model state the outcome probabilities depend on. */
export interface OutcomeState {
  /**
   * Chance that a call fails for good: refused by an overloaded or failed
   * target, timed out, shed or short-circuited, after the caller's retries.
   */
  callFailure(step: CallPathStep, hotKey: boolean): number;
  /** Hit ratio for keys that exist; requests for a hot key hit far more often. */
  hitRatio(componentId: string, entity: string | undefined, hotKey: boolean): number;
  negativeHitRatio(componentId: string, entity: string | undefined): number;
  /** Chance that a randomly drawn code for this entity is already taken (stored / keyspace, capped at 1). */
  occupancy(entity: string | undefined): number;
  /** Share of the keyspace taken by custom aliases, which generated keys can still meet. */
  aliasOccupancy(entity: string | undefined): number;
  /** Whether an entry of the entity exists for requests of this class. */
  exists(entity: string | undefined, cls: RequestClass): boolean;
}

/**
 * Work one batched call does, relative to a call for one item: the per-call
 * overhead (round trip, transaction, commit) dominates, and each extra item
 * adds a little.
 */
export const BATCH_ITEM_COST = 0.05;

/** Share of requests that make a batched call: one per batch. */
export function batchShare(step: PathStep): number {
  return step.kind === "call" && step.batchSize ? 1 / step.batchSize : 1;
}

/**
 * Batched allocation fetches ids ahead of the requests that use them, so a
 * failed call fails only the request that made it. Other batched calls (a
 * job's batched deletes) collect items first and succeed or fail together.
 */
export function prefetches(step: PathStep): boolean {
  // Only batched calls prefetch; most steps have no batch, so skip the action lookup.
  return (
    step.kind === "call" &&
    step.batchSize !== undefined &&
    ACTIONS[step.action].effect === "allocate"
  );
}

/** Whether items wait for a batch to fill before the call is made. */
export function collectsBatch(step: PathStep): step is CallPathStep {
  return step.kind === "call" && (step.batchSize ?? 1) > 1 && !prefetches(step);
}

/** Whether a fan-out fills batches with the request's own calls, waiting for nobody else. */
export function ownBatches(step: PathStep): boolean {
  return collectsBatch(step) && step.each !== undefined;
}

/** Calls a fan-out of n items makes: one per item, or one per batch of its own items. */
export function fanOutCalls(step: PathStep, n: number): number {
  return ownBatches(step) && step.kind === "call" ? Math.ceil(n / (step.batchSize ?? 1)) : n;
}

/**
 * Calls a path step makes per request on its path. A failed allocation call
 * was certainly made by the request that failed; otherwise about one request
 * in a batch makes the call (exact when the target does not drop calls).
 */
export function callShare(step: PathStep): number {
  return step.kind === "call" && step.outcome === "error" && prefetches(step)
    ? 1
    : batchShare(step);
}

/** How many times a request makes this call: once, or once per item of a count. */
export function fanOut(step: PathStep, cls: RequestClass): number {
  return step.kind === "call" && step.each !== undefined ? (cls.counts[step.each] ?? 0) : 1;
}

/** Whether a step sums what arrives per key over a window, then writes once per key. */
export function aggregates(step: PathStep): step is CallPathStep & { aggregateSec: number } {
  return step.kind === "call" && step.aggregateSec !== undefined;
}

/** Load one call puts on its target, in single-item calls. */
export function callCost(step: PathStep): number {
  return collectsBatch(step) ? 1 + BATCH_ITEM_COST * ((step.batchSize ?? 1) - 1) : 1;
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
      // A request sent again (same idempotency key) finds its first copy.
      return hasFact(cls, DUPLICATE_FACT) ? 1 : 0;
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
  // The request hands a fire-and-forget message to its buffer and moves on.
  if (step.fireAndForget || step.outbox) return step.outcome === "ok" ? 1 : 0;
  // A batched allocation is only made once per batch, so only then can it fail.
  const once = state.callFailure(step, cls.hotKey) * (prefetches(step) ? batchShare(step) : 1);
  // A fan-out fails if any of its calls fails; with nothing to fan out over, it cannot fail.
  const calls = step.each === undefined ? 1 : (cls.counts[step.each] ?? 0);
  const failure = calls === 1 ? once : 1 - (1 - once) ** calls;
  if (step.outcome === "error") return failure;
  const served = 1 - failure;
  switch (step.action) {
    case "cache.get": {
      if (state.exists(step.entity, cls)) {
        // A fan-out of lookups only hits when every one of them does.
        const once = state.hitRatio(step.target, step.entity, cls.hotKey);
        const hit = calls === 1 ? once : once ** calls;
        if (step.outcome === "hit") return served * hit;
        if (step.outcome === "miss") return served * (1 - hit);
        return 0;
      }
      const negative = state.negativeHitRatio(step.target, step.entity);
      if (step.outcome === "negativeHit") return served * negative;
      if (step.outcome === "miss") return served * (1 - negative);
      return 0;
    }
    case "store.read": {
      const exists = state.exists(step.entity, cls);
      if (step.outcome === "found") return exists ? served : 0;
      if (step.outcome === "notFound") return exists ? 0 : served;
      return 0;
    }
    case "store.update": {
      const exists = state.exists(step.entity, cls);
      if (step.outcome === "ok") return exists ? served : 0;
      if (step.outcome === "notFound") return exists ? 0 : served;
      return 0;
    }
    case "store.insertIfAbsent": {
      const conflict = conflictProbability(prior, cls, state, step.entity);
      if (step.outcome === "conflict") return served * conflict;
      return step.outcome === "ok" ? served * (1 - conflict) : 0;
    }
    default: {
      const rule = getAction(step.action).decidedBy;
      if (!rule) return step.outcome === "ok" ? served : 0;
      // Two answers besides an error; a fact about the request picks one.
      return (step.outcome === rule.outcome) === hasFact(cls, rule.fact) ? served : 0;
    }
  }
}

/** A logic step's outcome follows from a fact about the request, or is its only outcome. */
function logicProbability(logic: LogicId, outcome: string, cls: RequestClass): number {
  const def: LogicDef = LOGIC[logic];
  if (def.decidedBy)
    return (outcome === def.decidedBy.outcome) === hasFact(cls, def.decidedBy.fact) ? 1 : 0;
  return def.outcomes.length === 1 && def.outcomes[0] === outcome ? 1 : 0;
}
