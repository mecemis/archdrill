import {
  ACTIONS,
  type Attempt,
  type CatalogIndex,
  type Flow,
  feasibleOutcomes,
  liveStepIds,
  type Problem,
  type StepInput,
} from "@archdrill/model";
import { activePack, catalogIndex } from "../../state/content";
import { useAttemptStore } from "../../state/store";
import { useToasts } from "../../state/toasts";
import type { Attach, Slot } from "../../state/ui-store";

/**
 * The entity a call needs its target to store, when the target does not yet:
 * the same rule as validation (durable work needs a store that holds the
 * entity; short-lived entities may live in memory-only stores).
 */
export function missingBinding(
  attempt: Attempt,
  step: StepInput,
  problem: Problem,
  catalog: CatalogIndex,
): { readonly componentId: string; readonly entities: string[] } | null {
  if (step.type !== "call" || step.entity === undefined) return null;
  const target = attempt.architecture.components.find((c) => c.id === step.target);
  if (!target || !catalog.kind(target.kind)?.holdsData) return null;
  if (target.data.some((d) => d.entity === step.entity)) return null;
  const entity = problem.entities.find((e) => e.name === step.entity);
  const inMemory =
    entity?.ephemeral === true &&
    catalog.capabilities(target.kind, target.flavor).has("volatile-kv");
  if (ACTIONS[step.action].capability === "volatile-kv" || inMemory) return null;
  return {
    componentId: target.id,
    entities: [...target.data.map((d) => d.entity), step.entity],
  };
}

/**
 * Adds a step to a slot as one undoable change, binding its entity to the
 * target store first when the step needs that.
 */
export function addStepToSlot(slot: Slot, step: StepInput, continueWith?: string): boolean {
  const store = useAttemptStore.getState();
  const binding = missingBinding(store.attempt, step, activePack.problem, catalogIndex);
  const added = store.dispatchAll([
    ...(binding
      ? [
          {
            name: "setComponentData" as const,
            args: { id: binding.componentId, entities: binding.entities },
          },
        ]
      : []),
    {
      name: "addStep" as const,
      args: {
        operation: slot.operation,
        step,
        attach: slot.attach,
        ...(continueWith ? { continueWith: { outcome: continueWith } } : {}),
      },
    },
  ]);
  if (added && binding && step.type === "call") {
    const label =
      store.attempt.architecture.components.find((c) => c.id === binding.componentId)?.label ??
      binding.componentId;
    useToasts.getState().notify(`${label} now stores ${step.entity}.`);
  }
  return added;
}

/** Branches of a flow that lead nowhere yet, in tree order. */
export function openSlots(flow: Flow, attempt: Attempt): Attach[] {
  if (flow.root === null) return [{ to: "root" }];
  const slots: Attach[] = [];
  for (const stepId of liveStepIds(flow, attempt)) {
    const step = flow.steps[stepId];
    if (!step || step.type === "respond") continue;
    for (const outcome of feasibleOutcomes(step, attempt)) {
      if (step.next[outcome] === undefined) slots.push({ to: "outcome", stepId, outcome });
    }
  }
  return slots;
}
