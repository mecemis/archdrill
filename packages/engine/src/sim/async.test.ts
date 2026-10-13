import { type Attempt, EnvironmentSchema, WorkloadSchema } from "@archdrill/model";
import { asyncAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { BATCH_ITEM_COST } from "./outcomes";
import { MAX_DELIVERIES } from "./propagate";
import { simulateEnvironment } from "./simulate";

const workload = WorkloadSchema.parse({
  operations: {
    "create-link": {
      entity: "Link",
      classes: [
        { id: "generated", share: 0.99 },
        { id: "malicious", share: 0.01, malicious: true },
      ],
    },
    "purge-expired": { entity: "Link", classes: [{ id: "expired", share: 1, expired: true }] },
  },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
  // Each test simulates its own environment.
  environments: [{ id: "env", label: "Env", rates: { "create-link": 1 } }],
});

function simulate(attempt: Attempt, rates: Record<string, number>, faults: unknown[] = []) {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  const environment = EnvironmentSchema.parse({ id: "env", label: "Env", rates, faults });
  return simulateEnvironment(workload, environment, {
    attempt,
    catalog: testCatalogIndex,
    problem: testProblem,
    analysis,
  });
}

const scannerDown = [{ kind: "down", target: { capability: "external" } }];

describe("consumers", () => {
  it("receive every message their publishers publish, with the publishers' classes", () => {
    const metrics = simulate(asyncAttempt(), { "create-link": 1000 });
    const scan = metrics.operations.get("scan-link");

    expect(scan?.trigger).toBe("event");
    expect(scan?.rate).toBeCloseTo(1000, 6);
    // One URL check per message, and a disable for each malicious link.
    expect(metrics.components.get("safety")?.readLoad).toBeCloseTo(1000, 6);
    expect(metrics.components.get("db")?.writeLoad).toBeCloseTo(1000 + 10, 6);
    expect(scan?.successRate).toBeCloseTo(1, 9);
  });

  it("see failed messages again until the queue gives up on them", () => {
    const metrics = simulate(asyncAttempt(), { "create-link": 1000 }, scannerDown);
    const scan = metrics.operations.get("scan-link");

    expect(scan?.successRate).toBe(0);
    expect(scan?.redeliveries).toBeCloseTo(1000 * (MAX_DELIVERIES - 1), 6);
    expect(metrics.components.get("worker")?.writeLoad).toBeCloseTo(1000 * MAX_DELIVERIES, 6);
  });

  it("do not slow down or fail the requests that publish to them", () => {
    const intact = simulate(asyncAttempt(), { "create-link": 1000 });
    const down = simulate(asyncAttempt(), { "create-link": 1000 }, scannerDown);

    expect(down.operations.get("create-link")?.successRate).toBeCloseTo(1, 9);
    expect(down.operations.get("create-link")?.latency.p99).toBeCloseTo(
      intact.operations.get("create-link")?.latency.p99 ?? 0,
      6,
    );
  });

  it("fall behind instead of rejecting work when their workers are saturated", () => {
    const rates = { "create-link": 1000, "purge-expired": 4000 };
    const starved = simulate(asyncAttempt({ workers: 1 }), rates);
    const sized = simulate(asyncAttempt({ workers: 3 }), rates);

    expect(starved.operations.get("scan-link")?.backlogGrowth).toBeGreaterThan(100);
    expect(starved.operations.get("purge-expired")?.backlogGrowth).toBeGreaterThan(100);
    expect(sized.operations.get("scan-link")?.backlogGrowth).toBe(0);
    expect(sized.operations.get("purge-expired")?.backlogGrowth).toBe(0);
  });
});

describe("scheduled jobs", () => {
  it("start in their handler and report no backlog when they keep up", () => {
    const metrics = simulate(asyncAttempt(), { "purge-expired": 200 });
    const purge = metrics.operations.get("purge-expired");

    expect(purge?.trigger).toBe("schedule");
    expect(metrics.components.get("worker")?.writeLoad).toBeCloseTo(200, 6);
    expect(metrics.components.get("db")?.writeLoad).toBeCloseTo(200, 6);
    expect(purge?.backlogGrowth).toBe(0);
  });

  it("put far less load on the store when they delete in batches, and wait for each batch", () => {
    const batched = simulate(asyncAttempt({ purgeBatch: 100 }), { "purge-expired": 200 });
    const purge = batched.operations.get("purge-expired");

    // Two calls a second, each a little more work than a single delete.
    expect(batched.components.get("db")?.writeLoad).toBeCloseTo(2 * (1 + BATCH_ITEM_COST * 99), 6);
    // A batch of 100 fills in half a second; an item waits a quarter second on average.
    expect(purge?.latency.mean).toBeGreaterThan(240);
    expect(purge?.latency.mean).toBeLessThan(300);
  });

  it("fail a whole batch when its call fails", () => {
    const metrics = simulate(asyncAttempt({ purgeBatch: 100 }), { "purge-expired": 200 }, [
      { kind: "down", target: { capability: "durable-store" } },
    ]);

    expect(metrics.operations.get("purge-expired")?.successRate).toBeCloseTo(0, 9);
  });
});
