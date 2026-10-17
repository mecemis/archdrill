import { createAttemptStore, starterAttempt } from "./attempt-store";
import { activePack } from "./content";
import { loadAttempt, saveAttempt } from "./persistence";
import { slotStillValid } from "./slot";
import { useToasts } from "./toasts";
import { useUi } from "./ui-store";

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
  // A component clicked while adding steps may have been removed since.
  const target = ui.canvasTarget;
  if (target && !state.attempt.architecture.components.some((c) => c.id === target)) {
    ui.setCanvasTarget(null);
  }
});

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (saveTimer !== undefined) saveNow();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && saveTimer !== undefined) saveNow();
  });
}
