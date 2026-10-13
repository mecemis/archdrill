import { type Attempt, applyCommand, EnvironmentSchema, WorkloadSchema } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateEnvironment } from "./simulate";

const problem = {
  ...testProblem,
  counts: [{ id: "followees", label: "accounts followed", default: 200 }],
};

const workload = WorkloadSchema.parse({
  operations: {
    redirect: {
      entity: "Link",
      classes: [{ id: "all", share: 1 }],
    },
  },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
  environments: [{ id: "env", label: "Env", rates: { redirect: 1 } }],
});

const RATE = 100;

/** The cache-aside redirect, with its store read made once per followed account. */
function fanned(args: { batchSize?: number } = {}): Attempt {
  let a = applyCommand(cacheAsideAttempt(), "updateStep", {
    operation: "redirect",
    stepId: "read",
    each: "followees",
    ...args,
  }).attempt;
  // Every request misses the cache, so every request fans out.
  a = applyCommand(a, "linkOutcome", {
    operation: "redirect",
    stepId: "get",
    outcome: "hit",
    target: "read",
  }).attempt;
  return a;
}

function simulate(attempt: Attempt, faults: unknown[] = []) {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem });
  const environment = EnvironmentSchema.parse({
    id: "env",
    label: "Env",
    rates: { redirect: RATE },
    faults,
  });
  return simulateEnvironment(workload, environment, {
    attempt,
    catalog: testCatalogIndex,
    problem,
    analysis,
  });
}

describe("fan-out steps", () => {
  it("make one call per item of the count", () => {
    const metrics = simulate(fanned());

    expect(metrics.components.get("db")?.readLoad).toBeCloseTo(RATE * 200, 0);
  });

  it("carry their own items in batches, without waiting for other requests", () => {
    const single = simulate(fanned());
    const batched = simulate(fanned({ batchSize: 50 }));

    // 4 calls of 50, each costing 1 + 0.05 × 49.
    expect(batched.components.get("db")?.readLoad).toBeCloseTo(RATE * 4 * 3.45, 0);
    expect(batched.operations.get("redirect")?.latency.p99).toBeLessThan(
      single.operations.get("redirect")?.latency.p99 ?? 0,
    );
  });

  it("wait for the slowest call", () => {
    const one = simulate(
      applyCommand(fanned(), "updateStep", { operation: "redirect", stepId: "read", each: null })
        .attempt,
    );
    const many = simulate(fanned());

    expect(many.operations.get("redirect")?.latency.p50).toBeGreaterThan(
      one.operations.get("redirect")?.latency.p50 ?? 0,
    );
  });

  it("fail when any of their calls fails", () => {
    // A store that fails 1% of reads fails a 200-read fan-out about 87% of the time.
    const metrics = simulate(fanned(), [
      { kind: "degraded", target: { kind: "relational-db" }, capacity: 0.0049 },
    ]);

    expect(metrics.operations.get("redirect")?.successRate).toBeLessThan(0.5);
  });
});
