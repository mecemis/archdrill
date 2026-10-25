import type { EnvironmentMetrics } from "@archdrill/engine";
import { type Attempt, applyCommand, ScenarioSchema } from "@archdrill/model";
import {
  cacheAsideAttempt,
  createLinkAttempt,
  testCatalogIndex,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { evaluateAttempt } from "../evaluate";
import type { CheckResult } from "../score";
import { contextFor, mutated } from "../test-support";
import { CHECKS } from "./registry";

const check = (id: string, use: string, dimension: string, params: Record<string, unknown>) => ({
  id,
  use,
  title: id,
  dimension,
  params,
  why: "why it matters",
  fix: "how to fix",
});

function scenarioAt(rate: number) {
  return ScenarioSchema.parse({
    id: "load",
    problemId: "url-shortener",
    title: "Load",
    order: 3,
    story: "Traffic arrives.",
    focusOperations: ["redirect"],
    dimensions: { latency: 0.3, scalability: 0.3, "cache-efficiency": 0.2, cost: 0.2 },
    workload: {
      operations: {
        redirect: {
          entity: "Link",
          classes: [
            { id: "live", share: 0.99 },
            { id: "unknown", share: 0.01, exists: false },
          ],
        },
      },
      keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
      environments: [{ id: "peak", label: "Peak", rates: { redirect: rate } }],
    },
    checks: [
      check("p99", "latency-below", "latency", {
        operation: "redirect",
        environment: "peak",
        percentile: "p99",
        ms: 50,
      }),
      check("headroom", "utilization-below", "scalability", { environment: "peak", max: 0.8 }),
      check("success", "success-rate-above", "scalability", {
        operation: "redirect",
        environment: "peak",
        min: 0.999,
      }),
      check("hits", "hit-ratio-above", "cache-efficiency", {
        entity: "Link",
        environment: "peak",
        min: 0.7,
      }),
      check("budget", "cost-within-budget", "cost", { environment: "peak", monthlyUsd: 3000 }),
    ],
  });
}

function results(attempt: Attempt, rate: number): Map<string, CheckResult> {
  const [result] = evaluateAttempt(attempt, {
    problem: testProblem,
    scenarios: [scenarioAt(rate)],
    catalog: testCatalogIndex,
  }).scenarios;
  if (result?.status !== "evaluated") throw new Error(`not evaluated: ${result?.status}`);
  return new Map(result.checks.map((c) => [c.instance.id, c]));
}

describe("metric checks", () => {
  it("pass for a healthy design at moderate load", () => {
    const checks = results(cacheAsideAttempt(), 6000);

    expect([...checks.values()].map((c) => `${c.instance.id}:${c.status}`)).toEqual([
      "p99:pass",
      "headroom:pass",
      "success:pass",
      "hits:pass",
      "budget:pass",
    ]);
  });

  it("flag the overloaded component and the failed requests", () => {
    const checks = results(cacheAsideAttempt(), 20_000);

    expect(checks.get("headroom")?.status).toBe("fail");
    expect(checks.get("headroom")?.evidence).toContainEqual({
      type: "component",
      componentId: "api",
    });
    expect(checks.get("headroom")?.message).toContain("Link API is over capacity");
    expect(checks.get("success")?.status).toBe("fail");
  });

  it("explain a cold cache when nothing populates it", () => {
    const attempt = mutated("removeStep", {
      operation: "redirect",
      stepId: "populate",
      bypass: "ok",
    });

    const hits = results(attempt, 6000).get("hits");

    expect(hits?.status).toBe("fail");
    expect(hits?.message).toContain("never warms");
  });

  it("are not applicable to entities without a cache", () => {
    const attempt = mutated("removeStep", {
      operation: "redirect",
      stepId: "get",
      bypass: "miss",
      prune: true,
    });

    expect(results(attempt, 6000).get("hits")?.status).toBe("n/a");
  });

  it("refuse to call latency good when most requests fail", () => {
    const p99 = results(cacheAsideAttempt(), 60_000).get("p99");

    expect(p99?.status).toBe("fail");
    expect(p99?.message).toContain("succeed");
  });

  it("give partial credit just over budget and none far over it", () => {
    const pricier = mutated("updateComponent", { id: "db", replicas: 3 });
    const muchPricier = mutated("updateComponent", { id: "db", replicas: 6 });

    expect(results(pricier, 6000).get("budget")?.status).toBe("partial");
    expect(results(muchPricier, 6000).get("budget")?.status).toBe("fail");
    expect(results(muchPricier, 6000).get("budget")?.details[0]).toContain("Postgres");
  });

  it("treat a cache that no lookup reaches as not applicable, not as a 0% hit ratio", () => {
    const check = CHECKS.get("hit-ratio-above");
    if (!check) throw new Error("missing check");
    const env = {
      environment: { id: "peak", label: "Peak", rates: {} },
      caches: [
        { componentId: "redis", entity: "Link", hitRatio: 0, lookupRate: 0, populated: true },
      ],
      entityHitRatios: new Map([["Link", { lookupRate: 0, hitRatio: 0 }]]),
      converged: true,
    } as unknown as EnvironmentMetrics;
    const ctx = { ...contextFor(cacheAsideAttempt()), metrics: new Map([["peak", env]]) };

    const outcome = check.run(
      check.params.parse({ entity: "Link", environment: "peak", min: 0.8 }),
      ctx,
    );

    expect(outcome.status).toBe("n/a");
  });
});

describe("cost-within-budget", () => {
  it("says what a load balancer's capacity units are for", () => {
    const check = CHECKS.get("cost-within-budget");
    if (!check) throw new Error("missing check");
    const lb = {
      componentId: "lb",
      monthlyCost: 23_376,
      costBreakdown: { instances: 16, requests: 0, capacityUnits: 23_360, storage: 0 },
      capacityUnits: {
        units: 4000,
        by: "new-connections",
        newConnectionsPerSec: 100_000,
        activeConnections: 6e6,
        processedGbPerHour: 324,
        monthlyCost: 23_360,
      },
    };
    const env = {
      environment: { id: "avg", label: "Average day", rates: {} },
      components: new Map([["lb", lb]]),
      monthlyCost: 23_376,
      converged: true,
    } as unknown as EnvironmentMetrics;
    const ctx = { ...contextFor(cacheAsideAttempt()), metrics: new Map([["avg", env]]) };

    const outcome = check.run(check.params.parse({ environment: "avg", monthlyUsd: 10_000 }), ctx);

    expect(outcome.details).toEqual([
      "ALB: $23,376/month, $23,360 of it for 4,000 capacity units set by 100,000 new connections a second",
    ]);
  });

  it("says what sending to clients over the internet costs", () => {
    const check = CHECKS.get("cost-within-budget");
    if (!check) throw new Error("missing check");
    const photos = {
      componentId: "redis",
      monthlyCost: 4_000_000,
      costBreakdown: { instances: 0, requests: 160_000, storage: 37_000, internet: 3_803_000 },
      bytesToClients: 30e9,
      capacityUnits: null,
    };
    const env = {
      environment: { id: "avg", label: "Average day", rates: {} },
      components: new Map([["redis", photos]]),
      monthlyCost: 4_000_000,
      converged: true,
    } as unknown as EnvironmentMetrics;
    const ctx = { ...contextFor(cacheAsideAttempt()), metrics: new Map([["avg", env]]) };

    const outcome = check.run(check.params.parse({ environment: "avg", monthlyUsd: 10_000 }), ctx);

    expect(outcome.details).toEqual([
      "Redis: $4,000,000/month, $3,803,000 of it for sending 30 GB a second to clients over the internet",
    ]);
  });
});

describe("utilization-below", () => {
  const busy = (networkUtilization: number) =>
    ({
      environment: { id: "peak", label: "Peak", rates: {} },
      components: new Map([
        [
          "redis",
          {
            componentId: "redis",
            utilization: 0.9,
            hottestShardUtilization: 0.9,
            networkUtilization,
          },
        ],
      ]),
      converged: true,
    }) as unknown as EnvironmentMetrics;
  const run = (env: EnvironmentMetrics) => {
    const check = CHECKS.get("utilization-below");
    if (!check) throw new Error("missing check");
    const ctx = { ...contextFor(cacheAsideAttempt()), metrics: new Map([["peak", env]]) };
    return check.run(check.params.parse({ environment: "peak", max: 0.85 }), ctx);
  };

  it("says when the network, not the CPU, is what fills up", () => {
    expect(run(busy(0.9)).details[0]).toContain("fill its network bandwidth");
    expect(run(busy(0.2)).details[0]).not.toContain("network");
  });

  it("says when a store's volume is what fills up, and how much its page cache answers", () => {
    const env = busy(0.2);
    const redis = env.components.get("redis");
    const disk = {
      hitRatio: 0.012,
      readIops: 17011,
      writeIops: 747,
      limit: 20000,
      utilization: 0.9,
    };
    const reading = {
      ...env,
      components: new Map([["redis", { ...redis, disk }]]),
    } as unknown as EnvironmentMetrics;

    expect(run(reading).details[0]).toContain(
      "Its page cache answers 1.2% of reads; the rest read their pages from the volume: 17,758 I/Os a second on each copy, of the 20,000 one copy sustains.",
    );
  });
});

describe("success-rate-above", () => {
  const createScenario = ScenarioSchema.parse({
    id: "create",
    problemId: "url-shortener",
    title: "Create",
    order: 1,
    story: "Links are created.",
    focusOperations: ["create-link"],
    dimensions: { availability: 1 },
    workload: {
      operations: { "create-link": { entity: "Link", classes: [{ id: "generated", share: 1 }] } },
      keys: { Link: { existing: { distribution: "zipf", s: 1, population: 1e6 } } },
      dataset: { Link: 1.58e11 },
      keyspace: { Link: { alphabet: 62, lengthDecision: "code-length" } },
      environments: [{ id: "peak", label: "Peak", rates: { "create-link": 1000 } }],
    },
    checks: [
      check("success", "success-rate-above", "availability", {
        operation: "create-link",
        environment: "peak",
        min: 0.999,
      }),
    ],
  });

  it("names the step whose outcome sends requests to an error response", () => {
    const attempt = applyCommand(createLinkAttempt("random"), "setDecision", {
      decision: "code-length",
      option: "6",
    }).attempt;

    const [result] = evaluateAttempt(attempt, {
      problem: testProblem,
      scenarios: [createScenario],
      catalog: testCatalogIndex,
    }).scenarios;
    const success = result?.status === "evaluated" ? result.checks[0] : undefined;

    expect(success?.status).toBe("fail");
    expect(success?.details).toEqual([
      "100.0% of requests: Postgres · insert if absent: conflict → 503",
    ]);
  });
});
