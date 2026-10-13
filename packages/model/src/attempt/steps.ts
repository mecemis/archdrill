import { ACTIONS, CONDITIONAL_OUTCOMES } from "../catalog/actions";
import { LOGIC } from "../catalog/logic";
import type { Attempt, Flow, Step } from "./schema";

/** Every outcome a step's action or logic declares; respond steps produce none. */
export function stepOutcomes(step: Step): readonly string[] {
  switch (step.type) {
    case "call":
      return ACTIONS[step.action].outcomes;
    case "logic":
      return LOGIC[step.logic].outcomes;
    case "respond":
      return [];
  }
}

/** Key of one enabled conditional outcome, e.g. `cache.get|negativeHit|redis|Link`. */
function conditionalKey(
  action: string,
  outcome: string,
  target: string,
  entity: string | undefined,
) {
  return `${action}|${outcome}|${target}|${entity ?? ""}`;
}

function outcomesGiven(step: Step, enabled: ReadonlySet<string>): readonly string[] {
  const declared = stepOutcomes(step);
  if (step.type !== "call") return declared;
  // A fire-and-forget publish hands the message to a local buffer: the request never sees it fail.
  // So does an outbox message: it is part of the write before it, and the relay retries it.
  if (step.fireAndForget || step.outbox) return declared.filter((outcome) => outcome !== "error");
  const conditional = CONDITIONAL_OUTCOMES[step.action];
  if (!conditional) return declared;
  return declared.filter(
    (outcome) =>
      conditional[outcome] === undefined ||
      enabled.has(conditionalKey(step.action, outcome, step.target, step.entity)),
  );
}

function walk(flow: Flow, outcomesOf: (step: Step) => readonly string[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const step = flow.steps[id];
    if (!step) return;
    order.push(id);
    if (step.type === "respond") return;
    for (const outcome of outcomesOf(step)) {
      const next = step.next[outcome];
      if (next !== undefined) visit(next);
    }
  };
  if (flow.root !== null) visit(flow.root);
  return order;
}

const enabledCache = new WeakMap<Attempt, ReadonlySet<string>>();

/**
 * Conditional outcomes this design makes possible. Computed as a least fixed
 * point: start with none enabled, collect the enabling actions on steps that
 * are reachable through feasible outcomes only, and repeat until nothing new
 * is enabled. An enabling step hidden behind the very outcome it would enable
 * therefore never justifies itself.
 */
function enabledConditionalOutcomes(attempt: Attempt): ReadonlySet<string> {
  const cached = enabledCache.get(attempt);
  if (cached) return cached;
  let enabled: ReadonlySet<string> = new Set();
  for (;;) {
    const next = new Set<string>();
    for (const flow of attempt.flows) {
      for (const id of walk(flow, (step) => outcomesGiven(step, enabled))) {
        const step = flow.steps[id];
        if (step?.type !== "call") continue;
        for (const [action, outcomes] of Object.entries(CONDITIONAL_OUTCOMES)) {
          for (const [outcome, enabling] of Object.entries(outcomes ?? {})) {
            if (step.action === enabling)
              next.add(conditionalKey(action, outcome, step.target, step.entity));
          }
        }
      }
    }
    if (next.size === enabled.size) break;
    enabled = next;
  }
  enabledCache.set(attempt, enabled);
  return enabled;
}

/**
 * Outcomes that can actually happen in this design. Conditional outcomes (such
 * as a cache's negative hit) are only possible when a live step performs the
 * enabling action on the same target and entity.
 */
export function feasibleOutcomes(step: Step, attempt: Attempt): readonly string[] {
  return outcomesGiven(step, enabledConditionalOutcomes(attempt));
}

/** Steps a request can actually reach: from the root, through feasible outcomes only. */
export function liveStepIds(flow: Flow, attempt: Attempt): string[] {
  return walk(flow, (step) => feasibleOutcomes(step, attempt));
}

/** Feasible outcomes of a step that do not lead anywhere yet. */
export function unhandledOutcomes(step: Step, attempt: Attempt): string[] {
  if (step.type === "respond") return [];
  return feasibleOutcomes(step, attempt).filter((outcome) => step.next[outcome] === undefined);
}

/** Step ids linked from the flow root through any declared outcome, in depth-first order. */
export function reachableStepIds(flow: Flow): string[] {
  return walk(flow, stepOutcomes);
}

/** Returns one cycle (as step ids) if the flow graph has any, otherwise null. */
export function findCycle(flow: Flow): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === "done") return null;
    if (current === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    const step = flow.steps[id];
    if (!step) return null;
    state.set(id, "visiting");
    stack.push(id);
    if (step.type !== "respond") {
      for (const next of Object.values(step.next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const id of Object.keys(flow.steps).sort()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}
