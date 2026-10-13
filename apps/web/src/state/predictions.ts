import type { Prediction } from "@archdrill/model";
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

const isPrediction = (value: unknown): value is TimelinePrediction =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as TimelinePrediction).revealed === "boolean" &&
  typeof (value as TimelinePrediction).answers === "object" &&
  (value as TimelinePrediction).answers !== null;

function load(): Record<string, TimelinePrediction> {
  try {
    const text = safeStorage()?.getItem(KEY);
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => isPrediction(v)));
  } catch {
    return {};
  }
}

/**
 * The answers that still name an option of the timeline's questions; content
 * can change after an answer was stored.
 */
export function currentAnswers(
  answers: Readonly<Record<string, string>>,
  questions: readonly Prediction[],
): Record<string, string> {
  return Object.fromEntries(
    questions.flatMap((q) => {
      const chosen = answers[q.id];
      return chosen !== undefined && q.options.some((o) => o.id === chosen)
        ? [[q.id, chosen] as const]
        : [];
    }),
  );
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
