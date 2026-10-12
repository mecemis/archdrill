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

/**
 * Outcomes that can actually happen in this design. Conditional outcomes (such
 * as a cache's negative hit) are only possible when some flow performs the
 * enabling action on the same target and entity.
 */
export function feasibleOutcomes(step: Step, attempt: Attempt): readonly string[] {
  const declared = stepOutcomes(step);
  if (step.type !== "call") return declared;
  const conditional = CONDITIONAL_OUTCOMES[step.action];
  if (!conditional) return declared;
  return declared.filter((outcome) => {
    const enabling = conditional[outcome];
    return enabling === undefined || isPerformed(attempt, enabling, step.target, step.entity);
  });
}

function isPerformed(
  attempt: Attempt,
  action: string,
  target: string,
  entity: string | undefined,
): boolean {
  return attempt.flows.some((flow) =>
    reachableStepIds(flow).some((id) => {
      const s = flow.steps[id];
      return (
        s?.type === "call" && s.action === action && s.target === target && s.entity === entity
      );
    }),
  );
}

/** Feasible outcomes of a step that do not lead anywhere yet. */
export function unhandledOutcomes(step: Step, attempt: Attempt): string[] {
  if (step.type === "respond") return [];
  return feasibleOutcomes(step, attempt).filter((outcome) => step.next[outcome] === undefined);
}

/** Step ids reachable from the flow root, in depth-first order. */
export function reachableStepIds(flow: Flow): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const step = flow.steps[id];
    if (!step) return;
    order.push(id);
    if (step.type === "respond") return;
    for (const outcome of stepOutcomes(step)) {
      const next = step.next[outcome];
      if (next !== undefined) visit(next);
    }
  };
  if (flow.root !== null) visit(flow.root);
  return order;
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
