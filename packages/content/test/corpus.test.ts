import { evaluateAttempt, type ScenarioResult } from "@archdrill/evaluator";
import { type Attempt, applyCommand, type CommandName, validateAttempt } from "@archdrill/model";
import { describe, expect, it } from "vitest";
import { catalogIndex, getProblemPack } from "../src/index";
import { corpora, type Mutant } from "./corpus";

function packFor(problemId: string) {
  const pack = getProblemPack(problemId);
  if (!pack) throw new Error(`unknown problem ${problemId}`);
  return pack;
}

function scenarioResult(problemId: string, attempt: Attempt, scenarioId: string): ScenarioResult {
  const pack = packFor(problemId);
  // Only the scenario under test: timelines make the others cost real time.
  const scenarios = pack.scenarios.filter((s) => s.id === scenarioId);
  const result = evaluateAttempt(attempt, { ...pack, scenarios, catalog: catalogIndex })
    .scenarios[0];
  if (!result) throw new Error(`unknown scenario ${scenarioId}`);
  return result;
}

function applyMutant(base: Attempt, mutant: Mutant): Attempt {
  return mutant.apply.reduce(
    (attempt, step) => applyCommand(attempt, step.name as CommandName, step.args as never).attempt,
    base,
  );
}

describe.each(corpora.map((c) => [c.problemId, c] as const))(
  "corpus for %s",
  (problemId, corpus) => {
    const pack = packFor(problemId);

    describe.each(corpus.golden.map((g) => [g.id, g] as const))(
      "golden design %s",
      (_id, golden) => {
        it("validates without errors or warnings", () => {
          expect(
            validateAttempt(golden.attempt, { catalog: catalogIndex, problem: pack.problem }),
          ).toEqual([]);
        });

        it.each(Object.entries(golden.expect))(
          "reaches its expected score in %s",
          (scenarioId, expected) => {
            const result = scenarioResult(problemId, golden.attempt, scenarioId);

            expect(result.status).toBe("evaluated");
            if (result.status !== "evaluated") return;
            const failing = result.checks.filter(
              (c) => c.status === "fail" && c.instance.signal === "baseline",
            );
            expect(failing.map((c) => `${c.instance.id}: ${c.message}`)).toEqual([]);
            expect(result.scorecard.gateFailures).toEqual([]);
            expect(result.scorecard.score).toBeGreaterThanOrEqual(expected.minScore);
          },
        );
      },
    );

    const notPassing = corpus.golden.flatMap((g) =>
      g.notPassing.map((scenarioId) => [g.id, scenarioId, g] as const),
    );
    it.each(notPassing)("golden design %s does not pass %s", (_id, scenarioId, golden) => {
      const result = scenarioResult(problemId, golden.attempt, scenarioId);
      expect(result.status === "evaluated" && result.scorecard.band).toBe("not-passing");
    });

    describe.each(corpus.mutants.map((m) => [m.id, m] as const))("mutant %s", (_id, mutant) => {
      const golden = corpus.golden.find((g) => g.id === mutant.base);

      it("is caught by the evaluator", () => {
        expect(golden, `unknown base ${mutant.base}`).toBeDefined();
        if (!golden) return;
        const result = scenarioResult(
          problemId,
          applyMutant(golden.attempt, mutant),
          mutant.expect.scenario,
        );

        if (mutant.expect.invalid) {
          expect(result.status).toBe("invalid");
          if (result.status !== "invalid") return;
          expect(result.blocking.map((i) => i.code)).toEqual(
            expect.arrayContaining(mutant.expect.invalid),
          );
          return;
        }
        expect(result.status).toBe("evaluated");
        if (result.status !== "evaluated") return;
        const failing = result.checks
          .filter((c) => c.status === "fail" || c.status === "partial")
          .map((c) => c.instance.id);
        expect(failing).toEqual(expect.arrayContaining(mutant.expect.fails ?? []));
        if (mutant.expect.band) expect(result.scorecard.band).toBe(mutant.expect.band);
      });
    });
  },
);
