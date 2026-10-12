import { ACTIONS } from "../catalog/actions";
import { LOGIC } from "../catalog/logic";
import type { Flow, Step } from "./schema";

/** The closed set of outcomes a step can produce; respond steps produce none. */
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

/** Outcomes of a step that do not lead anywhere yet. */
export function unhandledOutcomes(step: Step): string[] {
  if (step.type === "respond") return [];
  return stepOutcomes(step).filter((outcome) => step.next[outcome] === undefined);
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
