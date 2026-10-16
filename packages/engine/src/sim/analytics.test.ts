import { type Attempt, EnvironmentSchema, WorkloadSchema } from "@archdrill/model";
import { clickAnalyticsAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateEnvironment } from "./simulate";

const workload = WorkloadSchema.parse({
  operations: {
    redirect: {
      entity: "Link",
      classes: [
        { id: "live", share: 0.99 },
        { id: "viral", share: 0, hotKey: true },
        { id: "unknown", share: 0.01, exists: false },
      ],
    },
  },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
  environments: [{ id: "env", label: "Env", rates: { redirect: 1 } }],
});

const RATE = 5000;
/** Half the clicks go to one link. */
const VIRAL = { redirect: { live: 0.49, viral: 0.5, unknown: 0.01 } };

function simulate(
  attempt: Attempt,
  { faults = [], classShares = {} }: { faults?: unknown[]; classShares?: unknown } = {},
) {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  const environment = EnvironmentSchema.parse({
    id: "env",
    label: "Env",
    rates: { redirect: RATE },
    faults,
    classShares,
  });
  return simulateEnvironment(workload, environment, {
    attempt,
    catalog: testCatalogIndex,
    problem: testProblem,
    analysis,
  });
}

const slowQueue = [{ kind: "slow", target: { kind: "queue" }, factor: 200 }];
const queueDown = [{ kind: "down", target: { kind: "queue" } }];

describe("publishing clicks", () => {
  it("counts a click for every redirect that answers 302", () => {
    const metrics = simulate(clickAnalyticsAttempt());

    expect(metrics.operations.get("record-click")?.rate).toBeCloseTo(RATE * 0.99, 3);
  });

  it("keeps fire-and-forget publishes off the request's time and outcome", () => {
    const intact = simulate(clickAnalyticsAttempt());
    const slow = simulate(clickAnalyticsAttempt(), { faults: slowQueue });
    const down = simulate(clickAnalyticsAttempt(), { faults: queueDown });

    const p99 = (m: typeof intact) => m.operations.get("redirect")?.latency.p99 ?? 0;
    expect(p99(slow)).toBeCloseTo(p99(intact), 4);
    expect(down.operations.get("redirect")?.successRate).toBeCloseTo(1, 9);
    // Clicks the queue cannot take are lost, not counted.
    expect(down.operations.get("record-click")?.rate ?? 0).toBeLessThan(1);
  });

  it("makes the redirect wait for a synchronous publish", () => {
    const intact = simulate(clickAnalyticsAttempt({ fireAndForget: false }));
    const slow = simulate(clickAnalyticsAttempt({ fireAndForget: false }), { faults: slowQueue });

    const p99 = (m: typeof intact) => m.operations.get("redirect")?.latency.p99 ?? 0;
    expect(p99(slow)).toBeGreaterThan(p99(intact) + 100);
  });
});

describe("counting clicks", () => {
  it("writes once per link and window when it aggregates", () => {
    const each = simulate(clickAnalyticsAttempt());
    const windowed = simulate(clickAnalyticsAttempt({ aggregateSec: 10 }));
    const writes = (m: typeof each) => m.components.get("stats")?.writeLoad ?? 0;

    expect(writes(each)).toBeCloseTo(RATE * 0.99, 3);
    expect(writes(windowed)).toBeLessThan(writes(each) * 0.9);
  });

  it("makes counts as stale as their window", () => {
    const windowed = simulate(clickAnalyticsAttempt({ aggregateSec: 30 }));

    expect(windowed.operations.get("record-click")?.latency.p99).toBeGreaterThan(29_000);
  });

  it("overloads the partition of a viral link, unless writes are aggregated or spread", () => {
    const store = { store: "dynamodb" as const };
    const each = simulate(clickAnalyticsAttempt(store), { classShares: VIRAL });
    const windowed = simulate(clickAnalyticsAttempt({ ...store, aggregateSec: 5 }), {
      classShares: VIRAL,
    });
    const spread = simulate(clickAnalyticsAttempt({ ...store, counterShards: 10 }), {
      classShares: VIRAL,
    });
    const hottest = (m: typeof each) => m.components.get("stats")?.hottestShardUtilization ?? 0;

    // 2,500 increments a second on one item, and their redeliveries; a partition takes 1,000.
    expect(hottest(each)).toBeGreaterThan(2.5);
    expect(each.operations.get("record-click")?.successRate).toBeLessThan(0.8);
    expect(hottest(windowed)).toBeLessThan(0.1);
    // Ten rows of 250 increments a second each.
    expect(hottest(spread)).toBeCloseTo(0.25, 2);
    // Ordinary links are not throttled with it.
    expect(each.components.get("stats")?.utilization).toBeLessThan(0.1);
  });

  it("cuts the load of batched writes, but not a per-request bill", () => {
    const store = { store: "dynamodb" as const, aggregateSec: 10 };
    const single = simulate(clickAnalyticsAttempt(store));
    const batched = simulate(clickAnalyticsAttempt({ ...store, batchSize: 100 }));
    const stats = (m: typeof single) => m.components.get("stats");

    expect(stats(batched)?.writeLoad).toBeLessThan((stats(single)?.writeLoad ?? 0) / 10);
    expect(stats(batched)?.costBreakdown.requests).toBeCloseTo(
      stats(single)?.costBreakdown.requests ?? 0,
      6,
    );
  });

  it("does not make rows keyed by something else hot", () => {
    const metrics = simulate(clickAnalyticsAttempt({ store: "dynamodb", dedupe: true }), {
      classShares: VIRAL,
    });

    expect(metrics.components.get("seen")?.hottestShardUtilization).toBeLessThan(0.1);
    expect(metrics.components.get("stats")?.hottestShardUtilization).toBeGreaterThan(1);
  });
});
