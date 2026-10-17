import { connectionToCall, type StepInput } from "@archdrill/model";
import type { AnyCommand } from "../../state/attempt-store";
import { activePack } from "../../state/content";
import { useAttemptStore } from "../../state/store";
import { useToasts } from "../../state/toasts";
import { missingBinding } from "./add-step";
import { appendStep, type EditContext, insertBefore, type Position } from "./flow-edits";
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
  const link = connectionToCall(ctx.flow.handler, step.target, ctx.attempt, ctx.catalog);
  if (link.kind === "connected") return { commands, connects: false };
  const connect: AnyCommand =
    link.kind === "reverse"
      ? { name: "reverseConnection", args: { id: link.id } }
      : { name: "addConnection", args: { from: ctx.flow.handler, to: step.target } };
  return { commands: [connect, ...commands], connects: true };
}

/**
 * Adds a chosen step as one undoable change, and says so when it connected
 * the service to a component or bound the entity to a store. Returns whether
 * the step was added.
 */
export function commitStep(ctx: EditContext, mode: PickerMode, step: StepInput): boolean {
  const { commands, connects } = chosenStepCommands(ctx, mode, step);
  if (commands.length === 0) return false;
  const binding = missingBinding(ctx.attempt, step, ctx.problem, ctx.catalog);
  const added = useAttemptStore.getState().dispatchAll(commands);
  if (!added || step.type !== "call") return added;
  const notes = [
    connects
      ? `${componentLabel(ctx.attempt, ctx.flow.handler)} is now connected to ${componentLabel(ctx.attempt, step.target)}.`
      : "",
    binding ? `${componentLabel(ctx.attempt, binding.componentId)} now stores ${step.entity}.` : "",
  ].filter(Boolean);
  if (notes.length > 0) useToasts.getState().notify(notes.join(" "));
  return added;
}
