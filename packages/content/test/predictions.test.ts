import { evaluateAttempt } from "@archdrill/evaluator";
import { type Attempt, applyCommand, type CommandName } from "@archdrill/model";
import { describe, expect, it } from "vitest";
import { catalogIndex, getProblemPack } from "../src/index";
import { corpora, type Mutant } from "./corpus";

function applyMutant(base: Attempt, mutant: Mutant): Attempt {
  return mutant.apply.reduce(
    (attempt, step) => applyCommand(attempt, step.name as CommandName, step.args as never).attempt,
    base,
  );
}

/**
 * A prediction is only worth asking if designs answer it differently: across
 * the goldens and the scenario's mutants, every question gets at least two
 * different answers.
 */
describe.each(corpora.map((c) => [c.problemId, c] as const))(
  "predictions for %s",
  (problemId, corpus) => {
    const pack = getProblemPack(problemId);
    if (!pack) throw new Error(`unknown problem ${problemId}`);
    const asking = pack.scenarios.filter((s) =>
      (s.workload?.timelines ?? []).some((t) => t.predictions.length > 0),
    );

    it.each(asking.map((s) => [s.id, s] as const))("separate designs in %s", (_id, scenario) => {
      const designs = [
        ...corpus.golden.map((g) => g.attempt),
        ...corpus.mutants
          .filter((m) => m.expect.scenario === scenario.id)
          .flatMap((m) => {
            const base = corpus.golden.find((g) => g.id === m.base);
            return base ? [applyMutant(base.attempt, m)] : [];
          }),
      ];
      const answers = new Map<string, Set<string>>();
      for (const attempt of designs) {
        const result = evaluateAttempt(attempt, {
          ...pack,
          scenarios: [scenario],
          catalog: catalogIndex,
        }).scenarios[0];
        if (result?.status !== "evaluated") continue;
        for (const timeline of result.timelines.values()) {
          for (const [id, answer] of timeline.predictions) {
            const key = `${timeline.timeline.id}/${id}`;
            answers.set(key, (answers.get(key) ?? new Set()).add(answer.optionId));
          }
        }
      }

      const asked = (scenario.workload?.timelines ?? []).flatMap((t) =>
        t.predictions.map((p) => `${t.id}/${p.id}`),
      );
      expect([...answers.keys()].sort()).toEqual([...asked].sort());
      for (const [key, options] of answers)
        expect({ key, answers: options.size > 1 }).toEqual({ key, answers: true });
    });
  },
);
