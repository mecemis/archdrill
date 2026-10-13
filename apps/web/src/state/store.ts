import type { Attempt } from "@archdrill/model";
import { createAttemptStore, starterAttempt } from "./attempt-store";
import { activePack } from "./content";
import { loadAttempt, saveAttempt } from "./persistence";
import { useToasts } from "./toasts";
import { type Slot, useUi } from "./ui-store";

const SAVE_DELAY_MS = 300;
const { problem } = activePack;

export const useAttemptStore = createAttemptStore(
  loadAttempt(problem.id) ?? starterAttempt(problem),
);

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let warnedAboutSaving = false;

function saveNow(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!saveAttempt(useAttemptStore.getState().attempt) && !warnedAboutSaving) {
    warnedAboutSaving = true;
    useToasts
      .getState()
      .notify("Your browser is not saving this design. Export it before leaving.", "error");
  }
}

/** A slot is stale when the flow changed so that the place it points at no longer exists or is filled. */
function slotStillValid(slot: Slot, attempt: Attempt): boolean {
  const flow = attempt.flows.find((f) => f.operation === slot.operation);
  if (!flow) return false;
  if (slot.before !== undefined) return slot.before in flow.steps;
  if (slot.attach.to === "root") return flow.root === null;
  const parent = flow.steps[slot.attach.stepId];
  return (
    parent !== undefined &&
    parent.type !== "respond" &&
    parent.next[slot.attach.outcome] === undefined
  );
}

useAttemptStore.subscribe((state, previous) => {
  if (state.attempt === previous.attempt) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);

  // Highlights and armed slots refer to paths and steps; a structural edit (not a move) invalidates them.
  const structural =
    state.attempt.architecture !== previous.attempt.architecture ||
    state.attempt.flows !== previous.attempt.flows;
  if (!structural) return;
  const ui = useUi.getState();
  ui.clearPin();
  ui.setHover(null);
  if (ui.slot && !slotStillValid(ui.slot, state.attempt)) ui.armSlot(null);
});

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (saveTimer !== undefined) saveNow();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && saveTimer !== undefined) saveNow();
  });
}
