import { type Attempt, applyCommand, WorkloadSchema } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateEnvironment } from "./simulate";

const workload = WorkloadSchema.parse({
  operations: {
    redirect: {
      entity: "Link",
      classes: [
        { id: "live", share: 0.98 },
        { id: "expired", share: 0.01, expired: true },
        { id: "unknown", share: 0.01, exists: false },
      ],
    },
  },
  keys: {
    Link: {
      existing: { distribution: "zipf", s: 1.05, population: 2e10 },
      absent: { distribution: "zipf", s: 0.7, population: 1e9 },
    },
  },
  dataset: { Link: 1e9 },
  environments: [{ id: "e", label: "E", rates: { redirect: 1 }, faults: [] }],
});

const stepIds = [
  "get",
  "expiryHit",
  "read",
  "expiryDb",
  "populate",
  "r302",
  "r404",
  "r410",
  "r503",
];

const designArb = fc.record({
  api: fc.integer({ min: 1, max: 60 }),
  redis: fc.integer({ min: 1, max: 6 }),
  redisShards: fc.integer({ min: 1, max: 4 }),
  db: fc.integer({ min: 1, max: 8 }),
  ttl: fc.integer({ min: 1, max: 86_400 }),
  relink: fc.option(
    fc.record({
      stepId: fc.constantFrom(...stepIds),
      outcome: fc.constantFrom(
        "hit",
        "miss",
        "error",
        "found",
        "notFound",
        "valid",
        "expired",
        "ok",
      ),
      target: fc.option(fc.constantFrom(...stepIds), { nil: null }),
    }),
    { nil: null },
  ),
});

type Design = typeof designArb extends fc.Arbitrary<infer T> ? T : never;

function build(d: Design): Attempt {
  let attempt = cacheAsideAttempt();
  const apply = (fn: () => Attempt) => {
    try {
      attempt = fn();
    } catch {
      // Commands that do not apply to this shape are skipped.
    }
  };
  apply(() => applyCommand(attempt, "updateComponent", { id: "api", replicas: d.api }).attempt);
  apply(
    () =>
      applyCommand(attempt, "updateComponent", {
        id: "redis",
        replicas: d.redis,
        shards: d.redisShards,
      }).attempt,
  );
  apply(() => applyCommand(attempt, "updateComponent", { id: "db", replicas: d.db }).attempt);
  apply(
    () =>
      applyCommand(attempt, "updateStep", {
        operation: "redirect",
        stepId: "populate",
        ttlSec: d.ttl,
      }).attempt,
  );
  if (d.relink) {
    const { stepId, outcome, target } = d.relink;
    apply(
      () =>
        applyCommand(attempt, "linkOutcome", { operation: "redirect", stepId, outcome, target })
          .attempt,
    );
  }
  return attempt;
}

function simulate(attempt: Attempt, rate: number) {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  if (analysis.operations.get("redirect")?.status !== "ready") return null;
  return simulateEnvironment(
    workload,
    { id: "e", label: "E", rates: { redirect: rate }, faults: [] },
    {
      attempt,
      catalog: testCatalogIndex,
      problem: testProblem,
      analysis,
    },
  );
}

const rateArb = fc.integer({ min: 1, max: 2_000_000 });

describe("simulation properties", () => {
  it("accounts for every request: success plus failures is 1", () => {
    fc.assert(
      fc.property(designArb, rateArb, (design, rate) => {
        const op = simulate(build(design), rate)?.operations.get("redirect");
        if (!op) return;
        const { rejected, unhandled, errorStatus } = op.failures;
        expect(op.successRate + rejected + unhandled + errorStatus).toBeCloseTo(1, 6);
      }),
      { numRuns: 200 },
    );
  });

  it("never produces NaN or infinite metrics", () => {
    fc.assert(
      fc.property(designArb, rateArb, (design, rate) => {
        const metrics = simulate(build(design), rate);
        if (!metrics) return;
        expect(Number.isFinite(metrics.monthlyCost)).toBe(true);
        for (const c of metrics.components.values()) {
          expect(Number.isFinite(c.utilization)).toBe(true);
          expect(Number.isFinite(c.latency.mean) && Number.isFinite(c.latency.variance)).toBe(true);
          expect(c.dropRate).toBeGreaterThanOrEqual(0);
          expect(c.dropRate).toBeLessThan(1);
        }
        for (const cache of metrics.caches) {
          expect(cache.hitRatio).toBeGreaterThanOrEqual(0);
          expect(cache.hitRatio).toBeLessThanOrEqual(1);
        }
        const op = metrics.operations.get("redirect");
        expect(Number.isFinite(op?.latency.p99)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("never lowers the success rate when a component gets more replicas", () => {
    fc.assert(
      fc.property(
        designArb,
        rateArb,
        fc.constantFrom("api", "redis", "db"),
        (design, rate, component) => {
          const before = simulate(build(design), rate)?.operations.get("redirect")?.successRate;
          const bigger = {
            ...design,
            [component]: design[component as "api" | "redis" | "db"] + 5,
          };
          const after = simulate(build(bigger), rate)?.operations.get("redirect")?.successRate;
          if (before === undefined || after === undefined) return;
          expect(after).toBeGreaterThanOrEqual(before - 1e-6);
        },
      ),
      { numRuns: 150 },
    );
  });
});
