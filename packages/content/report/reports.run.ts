import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { corpusReport } from "./corpus-report";
import { COMPONENTS, measureEvaluation } from "./performance";

/** p95 budget for evaluating every scenario without timelines; CI runners may set a looser one. */
const BUDGET_MS = Number(process.env.PERF_BUDGET_MS ?? 100);
/** p95 budget with every timeline simulated, in the evaluation worker. */
const TIMELINE_BUDGET_MS = Number(process.env.PERF_TIMELINE_BUDGET_MS ?? 2000);
const OUT = new URL("./out/", import.meta.url);

function publish(name: string, markdown: string): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(new URL(name, OUT), markdown);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${markdown}\n`);
}

describe("reports", () => {
  it("writes the corpus report, and every mutant is caught", () => {
    const { markdown, missed } = corpusReport();
    publish("corpus.md", `# Corpus report\n\n${markdown}`);

    expect(missed).toBe(0);
  });

  it("evaluates every scenario of a 30-component design within budget", () => {
    const measurements = measureEvaluation();
    const within = (m: (typeof measurements)[number]) =>
      m.analytic.p95 <= BUDGET_MS && m.full.p95 <= TIMELINE_BUDGET_MS;
    const rows = measurements.map(
      (m) =>
        `| ${m.design} | ${m.analytic.p50.toFixed(1)} | ${m.analytic.p95.toFixed(1)} | ${m.full.p50.toFixed(1)} | ${m.full.p95.toFixed(1)} | ${within(m) ? "✓" : "✗"} |`,
    );
    publish(
      "performance.md",
      [
        "# Evaluation time",
        "",
        `All scenarios, each golden design padded to ${COMPONENTS} components. Budgets: p95 ≤ ${BUDGET_MS} ms without timelines, ≤ ${TIMELINE_BUDGET_MS} ms with them.`,
        "",
        "| Design | p50 (ms) | p95 (ms) | p50 with timelines | p95 with timelines | Within budget |",
        "|---|---|---|---|---|---|",
        ...rows,
        "",
      ].join("\n"),
    );

    expect(measurements.filter((m) => !within(m)).map((m) => m.design)).toEqual([]);
  });
});
