import { evaluateAttempt } from "@archdrill/evaluator";
import { applyCommand } from "@archdrill/model";
import { catalogIndex, getProblemPack } from "../src/index";
import { corpora } from "../test/corpus";
import { BASELINE_REFERENCE_MS, timeReference } from "./runner-speed";

/** The architecture document's budget: all scenarios of a 30-component design. */
export const COMPONENTS = 30;
const WARM_UP_RUNS = 10;
const MEASURED_RUNS = 40;
/** Timelines take longer; fewer runs still give a stable p95. */
const FULL_RUNS = 20;

export interface Timing {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  /**
   * How many times longer this machine took for the reference workload,
   * timed between these runs, than the machine the budgets were set on.
   */
  readonly speed: number;
  /** The p95 divided by `speed`: what the budget is checked against. */
  readonly normalizedP95: number;
}

export interface Measurement {
  readonly design: string;
  /** Every scenario's environments, static checks and scoring, without timelines. */
  readonly analytic: Timing;
  /** The same with every timeline simulated, as the app evaluates a design. */
  readonly full: Timing;
}

const quantile = (sorted: readonly number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;

/**
 * Time to analyse, simulate and score every scenario, for each golden design
 * padded with extra services to 30 components, after the JIT has warmed up.
 */
export function measureEvaluation(): Measurement[] {
  const pack = getProblemPack("url-shortener");
  const corpus = corpora.find((c) => c.problemId === "url-shortener");
  if (!pack || !corpus) throw new Error("url-shortener content missing");
  const input = { ...pack, catalog: catalogIndex };
  return corpus.golden.map((golden) => {
    let attempt = golden.attempt;
    for (let i = 0; attempt.architecture.components.length < COMPONENTS; i++) {
      attempt = applyCommand(attempt, "addComponent", {
        id: `padding-${i}`,
        kind: "service",
        flavor: "generic",
        label: `Padding ${i}`,
        position: { x: 0, y: 0 },
      }).attempt;
    }
    const time = (timelines: boolean, runs: number): Timing => {
      for (let i = 0; i < WARM_UP_RUNS; i++) {
        evaluateAttempt(attempt, input, { timelines });
        timeReference();
      }
      const times: number[] = [];
      const references: number[] = [];
      for (let i = 0; i < runs; i++) {
        // Alternated, so the reference meets the machine the evaluations meet.
        references.push(timeReference());
        const started = performance.now();
        evaluateAttempt(attempt, input, { timelines });
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      references.sort((a, b) => a - b);
      const speed = quantile(references, 0.5) / BASELINE_REFERENCE_MS;
      const p95 = quantile(times, 0.95);
      return {
        p50: quantile(times, 0.5),
        p95,
        max: times.at(-1) ?? 0,
        speed,
        normalizedP95: p95 / speed,
      };
    };
    return {
      design: golden.id,
      analytic: time(false, MEASURED_RUNS),
      full: time(true, FULL_RUNS),
    };
  });
}
