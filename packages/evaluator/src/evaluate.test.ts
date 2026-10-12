import type { Attempt } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { evaluateAttempt, type ScenarioResult } from "./evaluate";
import { GATE_SCORE_CAP } from "./score";
import { mutated, redirectScenario } from "./test-support";

const input = { problem: testProblem, scenarios: [redirectScenario], catalog: testCatalogIndex };

function evaluate(attempt: Attempt): ScenarioResult {
  const result = evaluateAttempt(attempt, input).scenarios[0];
  if (!result) throw new Error("no result");
  return result;
}

function evaluated(attempt: Attempt) {
  const result = evaluate(attempt);
  if (result.status !== "evaluated") throw new Error(`expected evaluated, got ${result.status}`);
  return result;
}

describe("evaluateAttempt", () => {
  it("scores the complete cache-aside design as excellent", () => {
    const { scorecard } = evaluated(cacheAsideAttempt());

    expect(scorecard.gateFailures).toEqual([]);
    expect(scorecard.score).toBe(100);
    expect(scorecard.band).toBe("excellent");
  });

  it("reports dimensions without applicable checks as not evaluated", () => {
    const { scorecard } = evaluated(cacheAsideAttempt());
    const scalability = scorecard.dimensions.find((d) => d.dimension === "scalability");

    expect(scalability).toMatchObject({ score: null, checkCount: 0 });
  });

  it("caps the score when a gate fails", () => {
    const attempt = mutated("linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "notFound",
      target: "r503",
    });

    const { scorecard } = evaluated(attempt);

    expect(scorecard.gateFailures).toEqual(["unknown-code-404"]);
    expect(scorecard.score).toBeLessThanOrEqual(GATE_SCORE_CAP);
    expect(scorecard.band).toBe("not-passing");
  });

  it("lowers only the affected dimension for non-gate findings", () => {
    const attempt = mutated("removeStep", {
      operation: "redirect",
      stepId: "populate",
      bypass: "ok",
    });

    const { scorecard } = evaluated(attempt);
    const latency = scorecard.dimensions.find((d) => d.dimension === "latency");

    expect(latency?.score).toBe(0);
    expect(scorecard.gateFailures).toEqual([]);
    // correctness 0.4, availability 0.15 at 100; latency 0.25 at 0; renormalised over 0.8
    expect(scorecard.score).toBe(Math.round((100 * 0.55) / 0.8));
  });

  it("never scores advisory checks", () => {
    const attempt = mutated("addComponent", {
      kind: "cache",
      flavor: "redis",
      label: "Spare",
      position: { x: 0, y: 0 },
    });

    const result = evaluated(attempt);

    expect(result.checks.find((c) => c.instance.id === "unused")?.status).toBe("partial");
    expect(result.scorecard.score).toBe(100);
  });

  it("counts senior signals without penalising their absence", () => {
    const { scorecard } = evaluated(cacheAsideAttempt());

    expect(scorecard.signals.senior).toEqual({ demonstrated: 0, total: 1 });
  });

  it("refuses to score when the scenario's flow has validation errors", () => {
    const attempt = mutated("reverseConnection", { id: "api--db" });

    const result = evaluate(attempt);

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.blocking.map((i) => i.code)).toContain("step-no-connection");
    }
  });

  it("reports missing flows as incomplete instead of passing vacuously", () => {
    const attempt = mutated("removeFlow", { operation: "redirect" });

    expect(evaluate(attempt)).toEqual({
      scenarioId: "s2-redirect",
      status: "incomplete",
      operations: [{ operation: "redirect", status: "missing" }],
    });
  });

  it("is deterministic", () => {
    const first = evaluateAttempt(cacheAsideAttempt(), input).scenarios;
    const second = evaluateAttempt(cacheAsideAttempt(), input).scenarios;

    expect(second).toEqual(first);
  });
});
