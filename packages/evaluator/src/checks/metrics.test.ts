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
