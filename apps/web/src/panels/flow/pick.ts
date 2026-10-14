import type { StepInput } from "@archdrill/model";
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
 * Adds a chosen step as one undoable change, and says so when calling a
 * store bound the entity to it. Returns whether the step was added.
 */
export function commitStep(ctx: EditContext, mode: PickerMode, step: StepInput): boolean {
  const commands =
    mode.kind === "append"
      ? appendStep(ctx, mode.at, step)
      : insertBefore(ctx, mode.at, mode.before, step);
  if (commands.length === 0) return false;
  const binding = missingBinding(ctx.attempt, step, ctx.problem, ctx.catalog);
  const added = useAttemptStore.getState().dispatchAll(commands);
  if (added && binding && step.type === "call") {
    useToasts
      .getState()
      .notify(`${componentLabel(ctx.attempt, binding.componentId)} now stores ${step.entity}.`);
  }
  return added;
}
