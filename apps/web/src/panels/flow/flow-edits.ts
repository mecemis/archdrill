import {
  type Attempt,
  applyCommand,
  type CatalogIndex,
  type Flow,
  feasibleOutcomes,
  getLogic,
  outcomeTone,
  reachableStepIds,
  type Step,
  type StepInput,
} from "@archdrill/model";
import type { AnyCommand } from "../../state/attempt-store";
import { missingBinding } from "./add-step";
import { continuingOutcomes, defaultExitStatus, type ExitContext } from "./defaults";

/** Everything an edit needs to know about the flow it changes. */
export interface EditContext extends ExitContext {
  readonly flow: Flow;
  readonly catalog: CatalogIndex;
}

/** Where a new step goes: first in the flow, or behind outcomes of a step. */
export type Position =
  | { readonly kind: "root" }
  | { readonly kind: "after"; readonly stepId: string; readonly outcomes: readonly string[] };

/** Readable, unique step ids: "read-link", "check-expiry", "r404". */
function newStepId(step: StepInput, taken: Set<string>): string {
  const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const base =
    step.type === "respond"
      ? `r${step.status}`
      : step.type === "logic"
        ? kebab(step.logic)
        : `${kebab(step.action.split(".")[1] ?? step.action)}-${kebab(step.entity ?? step.event ?? step.target)}`;
  const clean = base.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^[^a-z0-9]+/, "s");
  let id = clean;
  for (let n = 2; taken.has(id); n++) id = `${clean}-${n}`;
  taken.add(id);
  return id;
}

/** Ids in use, plus those a batch is about to create. */
const takenIds = (flow: Flow) => new Set(Object.keys(flow.steps));

/** Respond steps are shared: one per status, created when first needed. */
function respondTo(
  ctx: EditContext,
  from: { readonly stepId: string; readonly outcome: string },
  status: number,
  taken: Set<string>,
  created: Map<number, string>,
): AnyCommand[] {
  const existing =
    created.get(status) ??
    Object.entries(ctx.flow.steps).find(
      ([, s]) => s.type === "respond" && s.status === status,
    )?.[0];
  if (existing) {
    return [
      {
        name: "linkOutcome",
        args: {
          operation: ctx.flow.operation,
          stepId: from.stepId,
          outcome: from.outcome,
          target: existing,
        },
      },
    ];
  }
  const id = newStepId({ type: "respond", status }, taken);
  created.set(status, id);
  return [
    {
      name: "addStep",
      args: {
        operation: ctx.flow.operation,
        id,
        step: { type: "respond", status },
        attach: { to: "outcome", stepId: from.stepId, outcome: from.outcome },
      },
    },
  ];
}

/** Outcomes of a new step that end the request, answered with their usual status. */
function defaultExits(
  ctx: EditContext,
  stepId: string,
  step: StepInput,
  taken: Set<string>,
  created: Map<number, string>,
  continuing: readonly string[] = continuingOutcomes(step),
): AnyCommand[] {
  if (step.type === "respond") return [];
  const outcomes = feasibleOutcomes({ ...step, next: {} } as Step, ctx.attempt);
  return (
    outcomes
      .filter((o) => !continuing.includes(o))
      // In a consumer, the other way of a decision (a large group, a match) needs steps of its own.
      .filter((o) => !(ctx.background && step.type === "logic" && outcomeTone(o) !== "positive"))
      .flatMap((outcome) => {
        const status = defaultExitStatus(outcome, ctx);
        return status === null ? [] : respondTo(ctx, { stepId, outcome }, status, taken, created);
      })
  );
}

function binding(ctx: EditContext, step: StepInput): AnyCommand[] {
  const missing = missingBinding(ctx.attempt, step, ctx.problem, ctx.catalog);
  return missing
    ? [{ name: "setComponentData", args: { id: missing.componentId, entities: missing.entities } }]
    : [];
}

/**
 * Adds a step at a position. Its outcomes that usually end a request are
 * answered with their usual status (errors with 503, not found with 404…);
 * the ones that carry on are left open for the next step.
 */
export function appendStep(ctx: EditContext, at: Position, step: StepInput): AnyCommand[] {
  if (at.kind === "after" && at.outcomes.length === 0) return [];
  const taken = takenIds(ctx.flow);
  const created = new Map<number, string>();
  const operation = ctx.flow.operation;
  if (step.type === "respond" && at.kind === "after") {
    return at.outcomes.flatMap((outcome) =>
      respondTo(ctx, { stepId: at.stepId, outcome }, step.status, taken, created),
    );
  }
  const id = newStepId(step, taken);
  const attach =
    at.kind === "root"
      ? { to: "root" as const }
      : { to: "outcome" as const, stepId: at.stepId, outcome: at.outcomes[0] as string };
  return [
    ...binding(ctx, step),
    { name: "addStep", args: { operation, id, step, attach } },
    ...(at.kind === "after"
      ? at.outcomes.slice(1).map((outcome) => ({
          name: "linkOutcome" as const,
          args: { operation, stepId: at.stepId, outcome, target: id },
        }))
      : []),
    ...defaultExits(ctx, id, step, taken, created),
  ];
}

/**
 * The outcomes of a new step that lead into the step it is put in front of:
 * usually the ones that carry on, but a decision that a call confirms (a
 * match on a local list, before the API that provides the list) leads into
 * that call with the outcome it confirms.
 */
function leadingInto(ctx: EditContext, step: StepInput, before: string): readonly string[] {
  if (step.type === "logic") {
    const logic = getLogic(step.logic);
    const next = ctx.flow.steps[before];
    const target =
      next?.type === "call"
        ? ctx.attempt.architecture.components.find((c) => c.id === next.target)
        : undefined;
    if (
      logic.needs &&
      logic.decidedBy &&
      target &&
      ctx.catalog.capabilities(target.kind, target.flavor).has(logic.needs.capability)
    ) {
      return [logic.decidedBy.outcome];
    }
  }
  return continuingOutcomes(step);
}

/** Puts a step in front of another; the new step carries on into it. */
export function insertBefore(
  ctx: EditContext,
  at: Position,
  before: string,
  step: StepInput,
): AnyCommand[] {
  if (step.type === "respond" || (at.kind === "after" && at.outcomes.length === 0)) return [];
  const continuing = leadingInto(ctx, step, before).filter((o) =>
    feasibleOutcomes({ ...step, next: {} } as Step, ctx.attempt).includes(o),
  );
  const [first, ...rest] = continuing;
  if (first === undefined) return [];
  const taken = takenIds(ctx.flow);
  const created = new Map<number, string>();
  const operation = ctx.flow.operation;
  const id = newStepId(step, taken);
  const attach =
    at.kind === "root"
      ? { to: "root" as const }
      : { to: "outcome" as const, stepId: at.stepId, outcome: at.outcomes[0] as string };
  return [
    ...binding(ctx, step),
    { name: "addStep", args: { operation, id, step, attach, continueWith: { outcome: first } } },
    ...(at.kind === "after"
      ? at.outcomes.slice(1).map((outcome) => ({
          name: "linkOutcome" as const,
          args: { operation, stepId: at.stepId, outcome, target: id },
        }))
      : []),
    ...rest.map((outcome) => ({
      name: "linkOutcome" as const,
      args: { operation, stepId: id, outcome, target: before },
    })),
    ...defaultExits(ctx, id, step, taken, created, continuing),
  ];
}

/** What an outcome of a step does instead. */
export type ExitChoice =
  | { readonly kind: "respond"; readonly status: number }
  | { readonly kind: "goto"; readonly target: string }
  /** Left open, to build steps of its own behind it. */
  | { readonly kind: "open" };

/** Points one or more outcomes of a step somewhere else. */
export function setExit(
  ctx: EditContext,
  stepId: string,
  outcomes: readonly string[],
  choice: ExitChoice,
): AnyCommand[] {
  const operation = ctx.flow.operation;
  const unlink = outcomes.map((outcome) => ({
    name: "linkOutcome" as const,
    args: { operation, stepId, outcome, target: null },
  }));
  if (choice.kind === "open") return unlink;
  if (choice.kind === "goto") {
    return outcomes.map((outcome) => ({
      name: "linkOutcome" as const,
      args: { operation, stepId, outcome, target: choice.target },
    }));
  }
  const taken = takenIds(ctx.flow);
  const created = new Map<number, string>();
  return [
    ...unlink,
    ...outcomes.flatMap((outcome) =>
      respondTo(ctx, { stepId, outcome }, choice.status, taken, created),
    ),
  ];
}

/** Removes a step; what followed it takes its place. */
export function removeStep(
  ctx: EditContext,
  stepId: string,
  continuing: readonly string[],
): AnyCommand[] {
  const step = ctx.flow.steps[stepId];
  const bypass =
    step && step.type !== "respond"
      ? continuing.find((o) => step.next[o] !== undefined)
      : undefined;
  return [
    {
      name: "removeStep",
      args: { operation: ctx.flow.operation, stepId, prune: true, ...(bypass ? { bypass } : {}) },
    },
  ];
}

/**
 * Adds removals for steps the edit cuts off from the first step, so a
 * replaced branch does not linger as unreachable steps.
 */
export function withPruning(
  attempt: Attempt,
  operation: string,
  commands: readonly AnyCommand[],
): AnyCommand[] {
  const flowOf = (a: Attempt) => a.flows.find((f) => f.operation === operation);
  const before = flowOf(attempt);
  if (!before) return [...commands];
  let after = attempt;
  try {
    for (const command of commands) {
      after = applyCommand(after, command.name, command.args as never).attempt;
    }
  } catch {
    // The batch itself fails; leave it to the store, which reports why.
    return [...commands];
  }
  const reachableBefore = new Set(reachableStepIds(before));
  const flowAfter = flowOf(after);
  if (!flowAfter) return [...commands];
  const reachableAfter = new Set(reachableStepIds(flowAfter));
  const cut = [...reachableBefore].filter((id) => !reachableAfter.has(id) && id in flowAfter.steps);
  return [
    ...commands,
    ...cut.map((stepId) => ({ name: "removeStep" as const, args: { operation, stepId } })),
  ];
}
