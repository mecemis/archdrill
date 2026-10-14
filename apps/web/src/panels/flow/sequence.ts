import { type Attempt, type Flow, feasibleOutcomes, type Step } from "@archdrill/model";
import { stepNumbers } from "../../canvas/projection";
import { continuingOutcomes } from "./defaults";

/**
 * A flow read top to bottom: a list of steps, where each step's other
 * outcomes end the request, jump elsewhere, or run a list of their own.
 * This is a view of the flow graph; every step and link stays visible.
 */
export interface Sequence {
  readonly items: readonly SequenceItem[];
  readonly end: SequenceEnd;
}

export interface SequenceItem {
  readonly stepId: string;
  readonly step: Exclude<Step, { type: "respond" }>;
  readonly number: number;
  /** Outcomes that lead to what follows in the list (the next item or the end). */
  readonly continuing: readonly string[];
  /** Every other outcome, in the step's outcome order. */
  readonly exits: readonly Exit[];
}

export type Exit =
  | {
      readonly kind: "respond";
      readonly outcome: string;
      readonly status: number;
      readonly target: string;
    }
  | {
      readonly kind: "goto";
      readonly outcome: string;
      readonly target: string;
      readonly number: number;
    }
  | { readonly kind: "branch"; readonly outcome: string; readonly branch: Sequence }
  | { readonly kind: "open"; readonly outcome: string };

/** How a list ends after its last item. */
export type SequenceEnd =
  | { readonly kind: "empty" }
  | { readonly kind: "respond"; readonly status: number; readonly target: string }
  | { readonly kind: "goto"; readonly target: string; readonly number: number }
  /** Nothing follows yet: the next step goes behind these outcomes of the last item. */
  | { readonly kind: "open"; readonly outcomes: readonly string[] };

interface Context {
  readonly flow: Flow;
  readonly attempt: Attempt;
  readonly numbers: ReadonlyMap<string, number>;
  /** Steps already placed somewhere in the view. */
  readonly placed: Set<string>;
}

/** Steps reachable from a step without passing placed ones: how much a branch holds. */
function reach(ctx: Context, from: string): number {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const step = ctx.flow.steps[id];
    if (!step || step.type === "respond" || seen.has(id) || ctx.placed.has(id)) continue;
    seen.add(id);
    for (const outcome of feasibleOutcomes(step, ctx.attempt)) {
      const next = step.next[outcome];
      if (next !== undefined) stack.push(next);
    }
  }
  return seen.size;
}

const isRespond = (ctx: Context, id: string | undefined) =>
  id !== undefined && ctx.flow.steps[id]?.type === "respond";

/**
 * What follows a step in its list: the unplaced step with the most behind it
 * (preferring the conventional continuing outcomes on a tie), else the
 * conventional outcomes when they are still open, else where they lead.
 */
function continuation(
  ctx: Context,
  step: Exclude<Step, { type: "respond" }>,
): { readonly target: string | undefined; readonly outcomes: readonly string[] } {
  const outcomes = feasibleOutcomes(step, ctx.attempt);
  const conventional = continuingOutcomes(step).filter((o) => outcomes.includes(o));
  let best: { target: string; size: number; preferred: boolean } | null = null;
  for (const outcome of outcomes) {
    const target = step.next[outcome];
    if (target === undefined || isRespond(ctx, target) || ctx.placed.has(target)) continue;
    const size = reach(ctx, target);
    const preferred = conventional.includes(outcome);
    if (!best || size > best.size || (size === best.size && preferred && !best.preferred)) {
      best = { target, size, preferred };
    }
  }
  if (best) {
    const target = best.target;
    return { target, outcomes: outcomes.filter((o) => step.next[o] === target) };
  }
  const openConventional = conventional.filter((o) => step.next[o] === undefined);
  if (openConventional.length > 0) return { target: undefined, outcomes: openConventional };
  const main = conventional[0] ?? outcomes[0];
  const target = main === undefined ? undefined : step.next[main];
  if (target === undefined) {
    const open = outcomes.filter((o) => step.next[o] === undefined);
    return { target: undefined, outcomes: open.slice(0, 1) };
  }
  return { target, outcomes: outcomes.filter((o) => step.next[o] === target) };
}

function build(ctx: Context, start: string | null): Sequence {
  if (start === null) return { items: [], end: { kind: "empty" } };
  // First the main line, so branches that rejoin it show as jumps, not copies.
  const chain: {
    stepId: string;
    step: Exclude<Step, { type: "respond" }>;
    continuing: readonly string[];
  }[] = [];
  let end: SequenceEnd = { kind: "empty" };
  let current: string | undefined = start;
  while (current !== undefined) {
    const step: Step | undefined = ctx.flow.steps[current];
    if (!step) break;
    if (step.type === "respond") {
      end = { kind: "respond", status: step.status, target: current };
      break;
    }
    if (ctx.placed.has(current)) {
      end = { kind: "goto", target: current, number: ctx.numbers.get(current) ?? 0 };
      break;
    }
    ctx.placed.add(current);
    const next = continuation(ctx, step);
    chain.push({ stepId: current, step, continuing: next.outcomes });
    if (next.target === undefined) {
      end = { kind: "open", outcomes: next.outcomes };
      break;
    }
    current = next.target;
  }
  const items = chain.map(({ stepId, step, continuing }) => ({
    stepId,
    step,
    number: ctx.numbers.get(stepId) ?? 0,
    continuing,
    exits: feasibleOutcomes(step, ctx.attempt)
      .filter((o) => !continuing.includes(o))
      .map((outcome) => exitFor(ctx, step, outcome)),
  }));
  return { items, end };
}

function exitFor(ctx: Context, step: Exclude<Step, { type: "respond" }>, outcome: string): Exit {
  const target = step.next[outcome];
  if (target === undefined) return { kind: "open", outcome };
  const next = ctx.flow.steps[target];
  if (next?.type === "respond") return { kind: "respond", outcome, status: next.status, target };
  if (ctx.placed.has(target)) {
    return { kind: "goto", outcome, target, number: ctx.numbers.get(target) ?? 0 };
  }
  return { kind: "branch", outcome, branch: build(ctx, target) };
}

/** The flow as a list of steps, numbered as on the canvas. */
export function sequenceOf(flow: Flow, attempt: Attempt): Sequence {
  return build(
    { flow, attempt, numbers: stepNumbers(flow, attempt), placed: new Set() },
    flow.root,
  );
}
