import { create } from "zustand";
import { activePack } from "./content";
import { safeStorage } from "./persistence";

/** What the candidate predicted for one timeline, and whether it has been revealed. */
export interface TimelinePrediction {
  /** Prediction id → chosen option id. */
  readonly answers: Readonly<Record<string, string>>;
  readonly revealed: boolean;
}

const KEY = `archdrill:predictions:${activePack.problem.id}`;

function load(): Record<string, TimelinePrediction> {
  try {
    const text = safeStorage()?.getItem(KEY);
    const parsed: unknown = text ? JSON.parse(text) : {};
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, TimelinePrediction>)
      : {};
  } catch {
    return {};
  }
}

function save(state: Record<string, TimelinePrediction>): void {
  try {
    safeStorage()?.setItem(KEY, JSON.stringify(state));
  } catch {
    // Predictions are a convenience; without storage they last for the session.
  }
}

interface PredictionState {
  /** By `scenarioId/timelineId`. */
  readonly byTimeline: Readonly<Record<string, TimelinePrediction>>;
  answer: (key: string, predictionId: string, optionId: string) => void;
  reveal: (key: string) => void;
  reset: (key: string) => void;
}

/**
 * Predict, then reveal: answers are kept per timeline (in this browser), so
 * a candidate who comes back sees what they predicted next to what happened.
 */
export const usePredictions = create<PredictionState>((set, get) => {
  const update = (key: string, next: TimelinePrediction | null) => {
    const byTimeline = { ...get().byTimeline };
    if (next) byTimeline[key] = next;
    else delete byTimeline[key];
    save(byTimeline);
    set({ byTimeline });
  };
  return {
    byTimeline: load(),
    answer(key, predictionId, optionId) {
      const current = get().byTimeline[key] ?? { answers: {}, revealed: false };
      update(key, { ...current, answers: { ...current.answers, [predictionId]: optionId } });
    },
    reveal(key) {
      const current = get().byTimeline[key] ?? { answers: {}, revealed: false };
      update(key, { ...current, revealed: true });
    },
    reset(key) {
      update(key, null);
    },
  };
});

export const predictionKey = (scenarioId: string, timelineId: string) =>
  `${scenarioId}/${timelineId}`;
