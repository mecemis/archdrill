import type { Attempt } from "@archdrill/model";
import type { Slot } from "./ui-store";

/**
 * A slot is stale when the flow changed so that the place it points at no
 * longer exists or is filled: an open outcome now leads somewhere, or the
 * step a new one goes in front of is no longer behind that outcome.
 */
export function slotStillValid(slot: Slot, attempt: Attempt): boolean {
  const flow = attempt.flows.find((f) => f.operation === slot.operation);
  if (!flow) return false;
  const leadsTo = (target: string | undefined) => {
    if (slot.attach.to === "root") return flow.root === (target ?? null);
    const parent = flow.steps[slot.attach.stepId];
    return (
      parent !== undefined &&
      parent.type !== "respond" &&
      parent.next[slot.attach.outcome] === target
    );
  };
  if (slot.before !== undefined) return slot.before in flow.steps && leadsTo(slot.before);
  return leadsTo(undefined);
}
