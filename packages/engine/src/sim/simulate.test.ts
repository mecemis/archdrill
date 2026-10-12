import { type Attempt, applyCommand, WorkloadSchema } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateEnvironment } from "./simulate";

const workload = WorkloadSchema.parse({
  operations: {
    redirect: {
      entity: "Link",
      classes: [
        { id: "live", share: 0.985 },
        { id: "expired", share: 0.005, expired: true },
        { id: "unknown", share: 0.01, exists: false },
      ],
    },
  },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
  environments: [{ id: "steady", label: "Steady", rates: { redirect: 6000 }, faults: [] }],
});

function simulate(attempt: Attempt, rate = 6000) {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  const environment = { id: "steady", label: "Steady", rates: { redirect: rate }, faults: [] };
  return simulateEnvironment(workload, environment, {
    attempt,
    catalog: testCatalogIndex,
    problem: testProblem,
    analysis,
  });
}

describe("simulateEnvironment", () => {
  it("assigns every request to exactly one path when nothing is overloaded", () => {
    const metrics = simulate(cacheAsideAttempt());
    const total = metrics.operations
      .get("redirect")
      ?.paths.reduce((sum, p) => sum + p.probability, 0);

    expect(metrics.converged).toBe(true);
    expect(total).toBeCloseTo(1, 10);
    expect(metrics.operations.get("redirect")?.successRate).toBeCloseTo(1, 10);
  });

  it("sends exactly the cache misses and unknown codes to the database", () => {
    const metrics = simulate(cacheAsideAttempt());
    const hit = metrics.caches[0]?.hitRatio ?? 0;
    const dbLoad = metrics.components.get("db")?.readLoad ?? 0;

    expect(hit).toBeGreaterThan(0.6);
    expect(hit).toBeLessThan(0.95);
    expect(dbLoad).toBeCloseTo(6000 * (0.99 * (1 - hit) + 0.01), 6);
  });

  it("never warms a cache that nothing writes to", () => {
    const attempt = applyCommand(cacheAsideAttempt(), "removeStep", {
      operation: "redirect",
      stepId: "populate",
      bypass: "ok",
    }).attempt;
    const metrics = simulate(attempt);

    expect(metrics.caches[0]).toMatchObject({ populated: false, hitRatio: 0 });
    expect(metrics.components.get("db")?.readLoad).toBeCloseTo(6000, 6);
  });

  it("rejects the excess when the service is overloaded", () => {
    // Three replicas of 3000/s handle 9000/s; 20000/s arrive.
    const metrics = simulate(cacheAsideAttempt(), 20_000);
    const api = metrics.components.get("api");

    expect(metrics.converged).toBe(true);
    expect(api?.utilization).toBeCloseTo(20_000 / 9000, 6);
    expect(metrics.operations.get("redirect")?.successRate).toBeCloseTo(9000 / 20_000, 4);
  });

  it("makes the requests an overloaded component still serves wait in its queue", () => {
    const op = simulate(cacheAsideAttempt(), 20_000).operations.get("redirect");

    expect(op?.latency.p99).toBeGreaterThan(1000);
  });

  it("shifts load to the database when an overloaded cache rejects lookups", () => {
    let attempt = applyCommand(cacheAsideAttempt(), "updateComponent", {
      id: "api",
      replicas: 200,
    }).attempt;
    attempt = applyCommand(attempt, "updateComponent", { id: "redis", replicas: 1 }).attempt;
    const metrics = simulate(attempt, 300_000);
    const cache = metrics.components.get("redis");
    const hit = metrics.caches[0]?.hitRatio ?? 0;
    const missesOnly = 300_000 * (0.99 * (1 - hit) + 0.01);

    expect(cache?.dropRate).toBeGreaterThan(0.2);
    expect(metrics.components.get("db")?.readLoad).toBeGreaterThan(missesOnly * 1.5);
  });

  it("makes hits faster than misses and orders the percentiles", () => {
    const metrics = simulate(cacheAsideAttempt());
    const op = metrics.operations.get("redirect");
    const hitPath = op?.paths.find((p) => p.pathId === "redirect#0");
    const missPath = op?.paths.find((p) => p.pathId === "redirect#2");

    expect(hitPath?.latency.mean).toBeLessThan(missPath?.latency.mean ?? 0);
    expect(op?.latency.p50).toBeLessThan(op?.latency.p95 ?? 0);
    expect(op?.latency.p95).toBeLessThan(op?.latency.p99 ?? 0);
  });

  it("prices instances by the hour", () => {
    // Fixture: 3 services at 0.17/h, 2 Redis nodes at 0.32/h, 2 Postgres at 1.4/h; the load balancer has no size.
    expect(simulate(cacheAsideAttempt()).monthlyCost).toBeCloseTo(
      (3 * 0.17 + 2 * 0.32 + 2 * 1.4) * 730,
      6,
    );
  });

  it("charges storage for every copy of the data", () => {
    const withData = WorkloadSchema.parse({ ...workload, dataset: { Link: 1e9 } });
    const attempt = cacheAsideAttempt();
    const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
    const metrics = simulateEnvironment(
      withData,
      { id: "steady", label: "Steady", rates: { redirect: 6000 }, faults: [] },
      {
        attempt,
        catalog: testCatalogIndex,
        problem: testProblem,
        analysis,
      },
    );

    // 1e9 links × 500 B = 500 GB per copy; the fixture's Postgres has 2 replicas.
    expect(metrics.components.get("db")?.storageGb).toBeCloseTo(1000, 6);
  });

  it("makes negative entries share cache memory with positive ones", () => {
    const withAbsent = WorkloadSchema.parse({
      ...workload,
      keys: {
        Link: {
          existing: { distribution: "zipf", s: 1.05, population: 2e10 },
          absent: { distribution: "zipf", s: 0.7, population: 1e9 },
        },
      },
    });
    // At 200k lookups/s memory, not the TTL, limits the hit ratio, so sharing it shows.
    const busy = applyCommand(cacheAsideAttempt(), "updateComponent", {
      id: "api",
      replicas: 100,
    }).attempt;
    const negative = applyCommand(busy, "addStep", {
      operation: "redirect",
      step: {
        type: "call",
        target: "redis",
        action: "cache.setNegative",
        entity: "Link",
        ttlSec: 3600,
      },
      attach: { to: "outcome", stepId: "read", outcome: "notFound" },
      continueWith: { outcome: "ok" },
    }).attempt;
    const run = (attempt: Attempt) => {
      const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
      const env = { id: "steady", label: "Steady", rates: { redirect: 200_000 }, faults: [] };
      return simulateEnvironment(withAbsent, env, {
        attempt,
        catalog: testCatalogIndex,
        problem: testProblem,
        analysis,
      });
    };

    const without = run(busy).caches[0];
    const shared = run(negative).caches[0];

    expect(shared?.negativeHitRatio).toBeGreaterThan(0);
    expect(shared?.hitRatio).toBeLessThan(without?.hitRatio ?? 0);
  });

  it("is deterministic", () => {
    expect(simulate(cacheAsideAttempt())).toEqual(simulate(cacheAsideAttempt()));
  });
});
