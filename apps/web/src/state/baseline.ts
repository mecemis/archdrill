import { type AttemptEvaluation, evaluateAttempt } from "@archdrill/evaluator";
import type { Attempt } from "@archdrill/model";
import { create } from "zustand";
import { activePack, catalogIndex } from "./content";
import { loadBaseline, saveBaseline } from "./persistence";

interface BaselineState {
  /** A pinned version of the design to compare the current one with. */
  readonly baseline: Attempt | null;
  readonly evaluation: AttemptEvaluation | null;
  /** Where the baseline came from: a pinned version, or a design file by name. */
  readonly source: string | null;
  pin: (attempt: Attempt, source?: string) => void;
  clear: () => void;
}

function evaluated(baseline: Attempt | null): AttemptEvaluation | null {
  return baseline ? evaluateAttempt(baseline, { ...activePack, catalog: catalogIndex }) : null;
}

/** The stored baseline and its evaluation; one that no longer evaluates is dropped. */
function restored(): Pick<BaselineState, "baseline" | "evaluation"> {
  const baseline = loadBaseline(activePack.problem.id);
  try {
    return { baseline, evaluation: evaluated(baseline) };
  } catch (error) {
    console.error("Dropped a stored baseline that could not be evaluated.", error);
    saveBaseline(activePack.problem.id, null);
    return { baseline: null, evaluation: null };
  }
}

export const useBaseline = create<BaselineState>((set) => ({
  ...restored(),
  source: null,
  /** Evaluates first, so a design that cannot be evaluated is never stored. */
  pin(attempt, source) {
    const evaluation = evaluated(attempt);
    saveBaseline(activePack.problem.id, attempt);
    set({ baseline: attempt, evaluation, source: source ?? null });
  },
  clear() {
    saveBaseline(activePack.problem.id, null);
    set({ baseline: null, evaluation: null, source: null });
  },
}));
