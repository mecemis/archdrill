import { type Attempt, ScenarioSchema } from "@archdrill/model";
import {
  asyncAttempt,
  cacheAsideAttempt,
  createLinkAttempt,
  testCatalogIndex,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { evaluateAttempt, type ScenarioResult } from "./evaluate";
import { GATE_SCORE_CAP, SEVERITY_SCORE_CAPS } from "./score";
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

  it("keeps a design with an open major finding out of the excellent band", () => {
    const attempt = mutated("updateComponent", { id: "api", replicas: 1 });

    const { scorecard } = evaluated(attempt);

    expect(scorecard.band).toBe("strong");
    expect(scorecard.score).toBeLessThanOrEqual(SEVERITY_SCORE_CAPS.major);
  });

  it("keeps a design with an open critical finding out of the strong band", () => {
    const critical = {
      ...redirectScenario,
      checks: redirectScenario.checks.map((c) =>
        c.id === "spof" ? { ...c, severity: "critical" as const } : c,
      ),
    };
    const attempt = mutated("updateComponent", { id: "api", replicas: 1 });

    const result = evaluateAttempt(attempt, { ...input, scenarios: [critical] }).scenarios[0];

    expect(result?.status === "evaluated" && result.scorecard).toMatchObject({
      score: SEVERITY_SCORE_CAPS.critical,
      band: "passing",
      cap: { reason: "critical", value: SEVERITY_SCORE_CAPS.critical },
    });
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

  it("leaves signals about approaches the design does not use out of the count", () => {
    const counterSignal = {
      id: "counter-obfuscated",
      use: "no-path",
      title: "Counters are scrambled",
      dimension: "latency",
      signal: "senior",
      params: {
        operation: "redirect",
        applicableWhen: { hasStep: { action: "coord.leaseRange" } },
        where: { hasStep: { action: "coord.leaseRange" } },
      },
      why: "w",
      fix: "f",
    };
    const scenario = ScenarioSchema.parse({
      ...redirectScenario,
      checks: [...redirectScenario.checks, counterSignal],
    });

    const result = evaluateAttempt(cacheAsideAttempt(), { ...input, scenarios: [scenario] })
      .scenarios[0];

    expect(result?.status === "evaluated" && result.scorecard.signals.senior).toEqual({
      demonstrated: 0,
      total: 1,
    });
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

  it("refuses to score a flow whose paths exceed the enumeration cap", () => {
    // Twelve two-way decisions that rejoin produce 4096 paths, above the cap.
    const base = cacheAsideAttempt();
    const steps: Record<string, unknown> = { done: { type: "respond", status: 302 } };
    for (let i = 0; i < 12; i++) {
      const next = i === 11 ? "done" : `c${i + 1}`;
      steps[`c${i}`] = {
        type: "logic",
        logic: "checkStatus",
        next: { active: next, disabled: next },
      };
    }
    const flow = base.flows[0];
    if (!flow) throw new Error("fixture changed");
    const attempt = {
      ...base,
      flows: [{ ...flow, root: "c0", steps: steps as typeof flow.steps }],
    };

    expect(evaluate(attempt)).toEqual({
      scenarioId: "s2-redirect",
      status: "incomplete",
      operations: [{ operation: "redirect", status: "too-complex" }],
    });
  });

  it("is deterministic", () => {
    const first = evaluateAttempt(cacheAsideAttempt(), input).scenarios;
    const second = evaluateAttempt(cacheAsideAttempt(), input).scenarios;

    expect(second).toEqual(first);
  });
});

describe("evaluateAttempt with optional consumers", () => {
  const scenario = ScenarioSchema.parse({
    id: "s7-edge-cases",
    problemId: "url-shortener",
    title: "Edge cases",
    order: 7,
    story: "Scan new links.",
    focusOperations: ["create-link", "scan-link"],
    dimensions: { security: 1 },
    checks: [
      {
        id: "scan-retried",
        use: "status-for-condition",
        title: "Failed scans are retried",
        dimension: "security",
        why: "An acknowledged failure drops the message.",
        fix: "Answer 503 on errors.",
        params: {
          operation: "scan-link",
          when: { hasStep: { outcome: "error" } },
          statuses: [503],
        },
      },
    ],
  });
  const evaluateWith = (attempt: Attempt) =>
    evaluateAttempt(attempt, { ...input, scenarios: [scenario] }).scenarios[0];

  it("evaluates a design that handles the work without a consumer, skipping its checks", () => {
    const result = evaluateWith(createLinkAttempt("kgs"));

    expect(result?.status).toBe("evaluated");
    if (result?.status !== "evaluated") return;
    expect(result.checks[0]?.status).toBe("n/a");
    expect(result.checks[0]?.message).toBe('This design does not use a "Scan new link" consumer.');
  });

  it("judges the consumer once the design has one", () => {
    const result = evaluateWith(asyncAttempt());

    expect(result?.status === "evaluated" && result.checks[0]?.status).toBe("pass");
  });
});
