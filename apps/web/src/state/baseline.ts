import { type AttemptEvaluation, evaluateAttempt } from "@archdrill/evaluator";
import type { Attempt } from "@archdrill/model";
import { create } from "zustand";
import { activePack, catalogIndex } from "./content";
import { loadBaseline, saveBaseline } from "./persistence";

interface BaselineState {
  /** A pinned version of the design to compare the current one with. */
  readonly baseline: Attempt | null;
  readonly evaluation: AttemptEvaluation | null;
  pin: (attempt: Attempt) => void;
  clear: () => void;
}

function evaluated(baseline: Attempt | null): AttemptEvaluation | null {
  return baseline ? evaluateAttempt(baseline, { ...activePack, catalog: catalogIndex }) : null;
}

const initial = loadBaseline(activePack.problem.id);

export const useBaseline = create<BaselineState>((set) => ({
  baseline: initial,
  evaluation: evaluated(initial),
  pin(attempt) {
    saveBaseline(activePack.problem.id, attempt);
    set({ baseline: attempt, evaluation: evaluated(attempt) });
  },
  clear() {
    saveBaseline(activePack.problem.id, null);
    set({ baseline: null, evaluation: null });
  },
}));
