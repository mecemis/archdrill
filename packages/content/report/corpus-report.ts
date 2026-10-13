import { evaluateAttempt, type ScenarioResult } from "@archdrill/evaluator";
import { type Attempt, applyCommand, type CommandName } from "@archdrill/model";
import { catalogIndex, getProblemPack } from "../src/index";
import { corpora, type Mutant, type ProblemCorpus } from "../test/corpus";

function applyMutant(base: Attempt, mutant: Mutant): Attempt {
  return mutant.apply.reduce(
    (attempt, step) => applyCommand(attempt, step.name as CommandName, step.args as never).attempt,
    base,
  );
}

function cell(result: ScenarioResult | undefined): string {
  if (!result) return "—";
  if (result.status !== "evaluated") return result.status;
  return `${result.scorecard.score} ${result.scorecard.band}`;
}

/** What a mutant broke and which checks (or validation issues) caught it. */
function mutantRow(
  corpus: ProblemCorpus,
  mutant: Mutant,
  input: Parameters<typeof evaluateAttempt>[1],
) {
  const base = corpus.golden.find((g) => g.id === mutant.base);
  if (!base)
    return { caught: false, line: `| ${mutant.id} | unknown base ${mutant.base} | | | ✗ |` };
  const result = evaluateAttempt(applyMutant(base.attempt, mutant), input).scenarios.find(
    (s) => s.scenarioId === mutant.expect.scenario,
  );
  const expected = mutant.expect.invalid ?? mutant.expect.fails ?? [];
  let found: string[] = [];
  if (result?.status === "invalid") found = result.blocking.map((i) => i.code);
  if (result?.status === "evaluated") {
    found = result.checks
      .filter((c) => c.status === "fail" || c.status === "partial")
      .map((c) => c.instance.id);
  }
  const caught =
    expected.every((id) => found.includes(id)) &&
    (!mutant.expect.band ||
      (result?.status === "evaluated" && result.scorecard.band === mutant.expect.band));
  const shown = [...new Set(found)].map((id) => (expected.includes(id) ? `**${id}**` : id));
  return {
    caught,
    line: `| ${mutant.id} | ${mutant.expect.scenario} | ${expected.join(", ")} | ${shown.join(", ")} | ${caught ? "✓" : "✗"} |`,
  };
}

/**
 * The corpus as a Markdown report: every golden design's score in every
 * scenario, and which checks catch every mutant.
 */
export function corpusReport(): { readonly markdown: string; readonly missed: number } {
  const lines: string[] = [];
  let missed = 0;
  for (const corpus of corpora) {
    const pack = getProblemPack(corpus.problemId);
    if (!pack) throw new Error(`unknown problem ${corpus.problemId}`);
    const input = { ...pack, catalog: catalogIndex };
    const scenarios = pack.scenarios.map((s) => s.id);
    lines.push(`## ${pack.problem.title}`, "", "### Golden designs", "");
    lines.push(
      `| Design | ${scenarios.join(" | ")} |`,
      `|---|${scenarios.map(() => "---").join("|")}|`,
    );
    for (const golden of corpus.golden) {
      const results = evaluateAttempt(golden.attempt, input).scenarios;
      const cells = scenarios.map((id) => {
        const shown = cell(results.find((r) => r.scenarioId === id));
        if (golden.expect[id]) return `${shown} (≥ ${golden.expect[id]?.minScore})`;
        if (golden.notPassing.includes(id)) return `${shown} (expected not passing)`;
        return shown;
      });
      lines.push(`| ${golden.id} | ${cells.join(" | ")} |`);
    }
    const rows = corpus.mutants.map((m) => mutantRow(corpus, m, input));
    const caught = rows.filter((r) => r.caught).length;
    missed += rows.length - caught;
    lines.push(
      "",
      `### Mutants: ${caught} of ${rows.length} caught by the checks that should catch them`,
      "",
      "| Mutant | Scenario | Expected | Failing or partial (expected in bold) | Caught |",
      "|---|---|---|---|---|",
      ...rows.map((r) => r.line),
      "",
    );
  }
  return { markdown: lines.join("\n"), missed };
}
