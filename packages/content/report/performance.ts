import { evaluateAttempt } from "@archdrill/evaluator";
import { applyCommand } from "@archdrill/model";
import { catalogIndex, getProblemPack } from "../src/index";
import { corpora } from "../test/corpus";

/** The architecture document's budget: all scenarios of a 30-component design. */
export const COMPONENTS = 30;
const WARM_UP_RUNS = 10;
const MEASURED_RUNS = 40;

export interface Measurement {
  readonly design: string;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
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
    for (let i = 0; i < WARM_UP_RUNS; i++) evaluateAttempt(attempt, input);
    const times: number[] = [];
    for (let i = 0; i < MEASURED_RUNS; i++) {
      const started = performance.now();
      evaluateAttempt(attempt, input);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    return {
      design: golden.id,
      p50: quantile(times, 0.5),
      p95: quantile(times, 0.95),
      max: times.at(-1) ?? 0,
    };
  });
}
