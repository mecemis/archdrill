import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { corpusReport } from "./corpus-report";
import { COMPONENTS, measureEvaluation } from "./performance";
import { BASELINE_REFERENCE_MS } from "./runner-speed";

/**
 * p95 budget for evaluating every scenario without timelines, on the machine
 * the budgets were set on: times elsewhere are divided by how much slower the
 * machine is. CI may set a looser one for what that correction misses.
 */
const BUDGET_MS = Number(process.env.PERF_BUDGET_MS ?? 100);
/** p95 budget with every timeline simulated, in the evaluation worker, corrected the same way. */
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
      m.analytic.normalizedP95 <= BUDGET_MS && m.full.normalizedP95 <= TIMELINE_BUDGET_MS;
    const rows = measurements.map(
      (m) =>
        `| ${m.design} | ${m.analytic.p50.toFixed(1)} | ${m.analytic.p95.toFixed(1)} | ×${m.analytic.speed.toFixed(2)} | **${m.analytic.normalizedP95.toFixed(1)}** | ${m.full.p95.toFixed(1)} | ×${m.full.speed.toFixed(2)} | **${m.full.normalizedP95.toFixed(1)}** | ${within(m) ? "✓" : "✗"} |`,
    );
    publish(
      "performance.md",
      [
        "# Evaluation time",
        "",
        `All scenarios, each golden design padded to ${COMPONENTS} components. Budgets: p95 ≤ ${BUDGET_MS} ms without timelines, ≤ ${TIMELINE_BUDGET_MS} ms with them, on the machine they were set on.`,
        "",
        `Machines differ, so a reference workload is timed between the runs: its median over ${BASELINE_REFERENCE_MS} ms, the time it takes on the machine the budgets were set on, is how much slower this machine was (×). The budget is checked against the p95 divided by it (bold).`,
        "",
        "| Design | p50 (ms) | p95 (ms) | Machine | p95 corrected | p95 with timelines | Machine | Corrected | Within budget |",
        "|---|---|---|---|---|---|---|---|---|",
        ...rows,
        "",
      ].join("\n"),
    );

    expect(measurements.filter((m) => !within(m)).map((m) => m.design)).toEqual([]);
  });
});
