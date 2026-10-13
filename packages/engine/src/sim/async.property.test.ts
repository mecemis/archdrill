import { type Attempt, applyCommand, EnvironmentSchema, WorkloadSchema } from "@archdrill/model";
import { asyncAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateEnvironment } from "./simulate";

function simulate(attempt: Attempt, rates: Record<string, number>, malicious: number) {
  const workload = WorkloadSchema.parse({
    operations: {
      "create-link": {
        entity: "Link",
        classes: [
          { id: "generated", share: 1 - malicious },
          { id: "malicious", share: malicious, malicious: true },
        ],
      },
      "purge-expired": { entity: "Link", classes: [{ id: "expired", share: 1, expired: true }] },
    },
    keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
    environments: [{ id: "env", label: "Env", rates }],
  });
  const environment = EnvironmentSchema.parse({ id: "env", label: "Env", rates });
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  return {
    analysis,
    metrics: simulateEnvironment(workload, environment, {
      attempt,
      catalog: testCatalogIndex,
      problem: testProblem,
      analysis,
    }),
  };
}

const designArb = fc.record({
  workers: fc.integer({ min: 1, max: 4 }),
  purgeBatch: fc.option(fc.integer({ min: 2, max: 1000 }), { nil: undefined }),
});
const loadArb = fc.record({
  creates: fc.double({ min: 1, max: 6000, noNaN: true }),
  purges: fc.double({ min: 1, max: 8000, noNaN: true }),
  malicious: fc.double({ min: 0, max: 0.2, noNaN: true }),
});

describe("background work properties", () => {
  it("delivers to a consumer exactly the messages its publishers publish", () => {
    fc.assert(
      fc.property(designArb, loadArb, (design, load) => {
        const { analysis, metrics } = simulate(
          asyncAttempt(design),
          { "create-link": load.creates, "purge-expired": load.purges },
          load.malicious,
        );
        const create = metrics.operations.get("create-link");
        const scan = metrics.operations.get("scan-link");
        if (!create || !scan) throw new Error("operations missing");
        const publishing = new Set(
          analysis.operations
            .get("create-link")
            ?.paths.filter((p) =>
              p.steps.some(
                (s) => s.kind === "call" && s.action === "queue.publish" && s.outcome === "ok",
              ),
            )
            .map((p) => p.id),
        );
        const share = create.paths
          .filter((p) => publishing.has(p.pathId))
          .reduce((sum, p) => sum + p.probability, 0);
        const published = create.rate * (1 - create.ingressRejectRate) * share;

        expect(scan.rate).toBeCloseTo(published, 6);
      }),
      { numRuns: 60 },
    );
  });

  it("keeps backlog growth between zero and the arrival rate", () => {
    fc.assert(
      fc.property(designArb, loadArb, (design, load) => {
        const { metrics } = simulate(
          asyncAttempt(design),
          { "create-link": load.creates, "purge-expired": load.purges },
          load.malicious,
        );
        for (const op of metrics.operations.values()) {
          expect(op.backlogGrowth).toBeGreaterThanOrEqual(0);
          expect(op.backlogGrowth).toBeLessThanOrEqual(op.rate * (1 + 1e-9));
          if (op.trigger === "request") expect(op.backlogGrowth).toBe(0);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("never puts more load on the store when the purge deletes in bigger batches", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 500 }),
        fc.double({ min: 1, max: 3000, noNaN: true }),
        (a, b, purges) => {
          const [small, large] = a <= b ? [a, b] : [b, a];
          const writes = (batch: number) => {
            const attempt = asyncAttempt({
              workers: 4,
              ...(batch > 1 ? { purgeBatch: batch } : {}),
            });
            return simulate(attempt, { "purge-expired": purges }, 0).metrics.components.get("db")
              ?.writeLoad;
          };

          expect(writes(large)).toBeLessThanOrEqual((writes(small) ?? 0) * (1 + 1e-9));
        },
      ),
      { numRuns: 60 },
    );
  });

  it("does not let a broken URL check fail the requests that publish to its consumer", () => {
    fc.assert(
      fc.property(loadArb, (load) => {
        const attempt = applyCommand(asyncAttempt({ workers: 4 }), "updateComponent", {
          id: "api",
          replicas: 6,
        }).attempt;
        const rates = { "create-link": load.creates };
        const healthy = simulate(attempt, rates, load.malicious).metrics;
        const down = simulateEnvironment(
          WorkloadSchema.parse({
            operations: {
              "create-link": { entity: "Link", classes: [{ id: "generated", share: 1 }] },
            },
            keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
            environments: [{ id: "env", label: "Env", rates }],
          }),
          EnvironmentSchema.parse({
            id: "env",
            label: "Env",
            rates,
            faults: [{ kind: "down", target: { capability: "external" } }],
          }),
          {
            attempt,
            catalog: testCatalogIndex,
            problem: testProblem,
            analysis: analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem }),
          },
        );

        expect(down.operations.get("create-link")?.successRate).toBeGreaterThanOrEqual(
          (healthy.operations.get("create-link")?.successRate ?? 0) - 1e-6,
        );
      }),
      { numRuns: 40 },
    );
  });
});
