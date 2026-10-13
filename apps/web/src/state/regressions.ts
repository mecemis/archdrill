import type { AttemptEvaluation, ScenarioResult } from "@archdrill/evaluator";
import { create } from "zustand";
import { activePack } from "./content";

/** A drop worth telling the candidate about: this many points, or a worse band. */
const NOTABLE_DROP = 5;
const BANDS = ["not-passing", "passing", "strong", "excellent"] as const;

export interface Regression {
  readonly from: number;
  readonly to: number;
  /** The check that newly fails, if one does. */
  readonly reason: string | null;
}

interface Snapshot {
  readonly score: number;
  readonly band: (typeof BANDS)[number];
  readonly failing: ReadonlySet<string>;
}

interface RegressionState {
  /** Scenarios whose score a recent change lowered, until the candidate looks at them. */
  readonly regressions: Readonly<Record<string, Regression>>;
  readonly previous: ReadonlyMap<string, Snapshot>;
  readonly generation: number;
  /** Compares a new evaluation with the last one; returns the regressions it adds. */
  observe: (
    evaluation: AttemptEvaluation,
    generation: number,
    current: string,
  ) => [string, Regression][];
  acknowledge: (scenarioId: string) => void;
}

function snapshot(result: ScenarioResult): Snapshot | null {
  if (result.status !== "evaluated") return null;
  return {
    score: result.scorecard.score,
    band: result.scorecard.band,
    failing: new Set(
      result.checks
        .filter(
          (c) =>
            c.instance.signal === "baseline" && (c.status === "fail" || c.status === "partial"),
        )
        .map((c) => c.instance.title),
    ),
  };
}

const worse = (before: Snapshot, after: Snapshot) =>
  before.score - after.score >= NOTABLE_DROP ||
  BANDS.indexOf(after.band) < BANDS.indexOf(before.band);

export const useRegressions = create<RegressionState>((set, get) => ({
  regressions: {},
  previous: new Map(),
  generation: -1,
  observe(evaluation, generation, current) {
    const state = get();
    const sameDesign = state.generation === generation;
    const next = new Map<string, Snapshot>();
    const regressions = sameDesign ? { ...state.regressions } : {};
    const added: [string, Regression][] = [];
    for (const result of evaluation.scenarios) {
      const now = snapshot(result);
      if (!now) continue;
      next.set(result.scenarioId, now);
      const before = state.previous.get(result.scenarioId);
      const open = regressions[result.scenarioId];
      if (open && now.score >= open.from) delete regressions[result.scenarioId];
      if (!sameDesign || !before || result.scenarioId === current || !worse(before, now)) continue;
      const reason = [...now.failing].find((title) => !before.failing.has(title)) ?? null;
      const regression = { from: open?.from ?? before.score, to: now.score, reason };
      regressions[result.scenarioId] = regression;
      added.push([result.scenarioId, regression]);
    }
    set({ previous: next, regressions, generation });
    return added;
  },
  acknowledge(scenarioId) {
    const { [scenarioId]: _, ...rest } = get().regressions;
    set({ regressions: rest });
  },
}));

/** One line for a toast: "S2 Redirect dropped from 100 to 79: Redirect p99 …". */
export function describeRegression(scenarioId: string, regression: Regression): string {
  const scenario = activePack.scenarios.find((s) => s.id === scenarioId);
  const name = scenario ? `S${scenario.order} ${scenario.title}` : scenarioId;
  const why = regression.reason ? `: ${regression.reason}` : "";
  return `${name} dropped from ${regression.from} to ${regression.to}${why}.`;
}

/** One line for several scenarios at once: "This change lowered 3 scenarios: S2 100→40, …". */
export function describeRegressions(regressions: readonly [string, Regression][]): string {
  const parts = regressions.map(([id, r]) => {
    const order = activePack.scenarios.find((s) => s.id === id)?.order;
    return `${order === undefined ? id : `S${order}`} ${r.from}→${r.to}`;
  });
  return `This change lowered ${regressions.length} scenarios: ${parts.join(", ")}.`;
}
