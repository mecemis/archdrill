import { createAttemptStore, starterAttempt } from "./attempt-store";
import { activePack } from "./content";
import { loadAttempt, saveAttempt } from "./persistence";

const SAVE_DELAY_MS = 300;
const { problem } = activePack;

export const useAttemptStore = createAttemptStore(
  loadAttempt(problem.id) ?? starterAttempt(problem.id, problem.version),
);

let saveTimer: ReturnType<typeof setTimeout> | undefined;
useAttemptStore.subscribe((state, previous) => {
  if (state.attempt === previous.attempt) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveAttempt(state.attempt), SAVE_DELAY_MS);
});
