import { connectionToCall, type StepInput } from "@archdrill/model";
import type { AnyCommand } from "../../state/attempt-store";
import { activePack } from "../../state/content";
import { useAttemptStore } from "../../state/store";
import { useToasts } from "../../state/toasts";
import { missingBinding } from "./add-step";
import { addSteps, appendStep, type EditContext, insertBefore, type Position } from "./flow-edits";
import { type Pattern, patternTargets } from "./patterns";
import { componentLabel } from "./step-label";

/** What a new step does: go at a position, or in front of another step. */
export type PickerMode =
  | { readonly kind: "append"; readonly at: Position }
  | { readonly kind: "insert"; readonly at: Position; readonly before: string };

/** The entity an operation works on, from the scenarios' workloads. */
export function operationEntity(operation: string): string {
  for (const scenario of activePack.scenarios) {
    const entity = scenario.workload?.operations[operation]?.entity;
    if (entity) return entity;
  }
  return activePack.problem.entities[0]?.name ?? "";
}

/** The command that lets the service call a component, or null when it already can. */
function connectCommand(ctx: EditContext, target: string): AnyCommand | null {
  const link = connectionToCall(ctx.flow.handler, target, ctx.attempt, ctx.catalog);
  if (link.kind === "connected") return null;
  return link.kind === "reverse"
    ? { name: "reverseConnection", args: { id: link.id } }
    : { name: "addConnection", args: { from: ctx.flow.handler, to: target } };
}

/**
 * The commands that add a chosen step, as one change: when the service is not
 * connected to the component it calls, the connection comes first.
 */
export function chosenStepCommands(
  ctx: EditContext,
  mode: PickerMode,
  step: StepInput,
): { readonly commands: AnyCommand[]; readonly connects: boolean } {
  const commands =
    mode.kind === "append"
      ? appendStep(ctx, mode.at, step)
      : insertBefore(ctx, mode.at, mode.before, step);
  if (commands.length === 0 || step.type !== "call") return { commands, connects: false };
  const connect = connectCommand(ctx, step.target);
  return connect
    ? { commands: [connect, ...commands], connects: true }
    : { commands, connects: false };
}

/**
 * The commands that add a pattern's steps, as one change: the service is
 * connected first to the components it does not call yet. `connects` names them.
 */
export function patternCommands(
  ctx: EditContext,
  mode: PickerMode,
  pattern: Pattern,
): { readonly commands: AnyCommand[]; readonly connects: readonly string[] } {
  const steps = addSteps(ctx, mode.at, mode.kind === "insert" ? mode.before : null, pattern.steps);
  if (steps.length === 0) return { commands: [], connects: [] };
  const connects = patternTargets(pattern).flatMap((target) => {
    const command = connectCommand(ctx, target);
    return command ? [{ target, command }] : [];
  });
  return {
    commands: [...connects.map((c) => c.command), ...steps],
    connects: connects.map((c) => c.target),
  };
}

/** "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Says what adding steps changed besides the flow: new connections, entities a store now holds. */
function notifyChanges(
  ctx: EditContext,
  connects: readonly string[],
  steps: readonly StepInput[],
): void {
  const label = (id: string) => componentLabel(ctx.attempt, id);
  const stored = new Map<string, string>();
  for (const step of steps) {
    const binding = missingBinding(ctx.attempt, step, ctx.problem, ctx.catalog);
    if (binding && step.type === "call" && step.entity !== undefined) {
      stored.set(
        `${binding.componentId} ${step.entity}`,
        `${label(binding.componentId)} now stores ${step.entity}.`,
      );
    }
  }
  const notes = [
    connects.length > 0
      ? `${label(ctx.flow.handler)} is now connected to ${listed(connects.map(label))}.`
      : "",
    ...stored.values(),
  ].filter(Boolean);
  if (notes.length > 0) useToasts.getState().notify(notes.join(" "));
}

/**
 * Adds a chosen step as one undoable change, and says so when it connected
 * the service to a component or bound the entity to a store. Returns whether
 * the step was added.
 */
export function commitStep(ctx: EditContext, mode: PickerMode, step: StepInput): boolean {
  const { commands, connects } = chosenStepCommands(ctx, mode, step);
  if (commands.length === 0) return false;
  const added = useAttemptStore.getState().dispatchAll(commands);
  if (added && step.type === "call") notifyChanges(ctx, connects ? [step.target] : [], [step]);
  return added;
}

/** Adds a pattern's steps as one undoable change, like a step. Returns whether they were added. */
export function commitPattern(ctx: EditContext, mode: PickerMode, pattern: Pattern): boolean {
  const { commands, connects } = patternCommands(ctx, mode, pattern);
  if (commands.length === 0) return false;
  const added = useAttemptStore.getState().dispatchAll(commands);
  if (added) {
    notifyChanges(
      ctx,
      connects,
      pattern.steps.map((s) => s.step),
    );
  }
  return added;
}
