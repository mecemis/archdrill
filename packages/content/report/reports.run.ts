import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { corpusReport } from "./corpus-report";
import { COMPONENTS, measureEvaluation } from "./performance";

/** p95 budget for evaluating every scenario; CI runners may set a looser one. */
const BUDGET_MS = Number(process.env.PERF_BUDGET_MS ?? 100);
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
    const rows = measurements.map(
      (m) =>
        `| ${m.design} | ${m.p50.toFixed(1)} | ${m.p95.toFixed(1)} | ${m.max.toFixed(1)} | ${m.p95 <= BUDGET_MS ? "✓" : "✗"} |`,
    );
    publish(
      "performance.md",
      [
        "# Evaluation time",
        "",
        `All scenarios, each golden design padded to ${COMPONENTS} components; budget p95 ≤ ${BUDGET_MS} ms.`,
        "",
        "| Design | p50 (ms) | p95 (ms) | max (ms) | Within budget |",
        "|---|---|---|---|---|",
        ...rows,
        "",
      ].join("\n"),
    );

    expect(measurements.filter((m) => m.p95 > BUDGET_MS).map((m) => m.design)).toEqual([]);
  });
});
