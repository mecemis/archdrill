import {
  type Attempt,
  applyCommand,
  type CommandArgs,
  type CommandName,
  WorkloadSchema,
} from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateEnvironment } from "./simulate";

const viral = WorkloadSchema.parse({
  operations: {
    redirect: {
      entity: "Link",
      classes: [
        { id: "viral", share: 0.3, hotKey: true },
        { id: "live", share: 0.7 },
      ],
    },
  },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
  environments: [{ id: "spike", label: "Spike", rates: { redirect: 1 } }],
});

function apply<N extends CommandName>(attempt: Attempt, name: N, args: CommandArgs<N>): Attempt {
  return applyCommand(attempt, name, args).attempt;
}

function simulate(attempt: Attempt, rate: number) {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  return simulateEnvironment(
    viral,
    { id: "spike", label: "Spike", rates: { redirect: rate }, faults: [] },
    { attempt, catalog: testCatalogIndex, problem: testProblem, analysis },
  );
}

/** Cache-aside with 150 API instances and a Redis tier of four unreplicated shards. */
function shardedDesign(): Attempt {
  const big = apply(cacheAsideAttempt(), "updateComponent", { id: "api", replicas: 150 });
  return apply(big, "updateComponent", { id: "redis", shards: 4, replicas: 1 });
}

/** Adds an in-process cache in front of Redis, filled from Redis hits with a 10 s TTL. */
function withNearCache(base: Attempt): Attempt {
  let a = apply(base, "addComponent", {
    id: "near",
    kind: "near-cache",
    flavor: "lru",
    label: "Near cache",
    position: { x: 0, y: 0 },
  });
  a = apply(a, "addConnection", { from: "api", to: "near" });
  a = apply(a, "addStep", {
    operation: "redirect",
    id: "near-get",
    step: { type: "call", target: "near", action: "cache.get", entity: "Link" },
    attach: { to: "root" },
    continueWith: { outcome: "miss" },
  });
  a = apply(a, "linkOutcome", {
    operation: "redirect",
    stepId: "near-get",
    outcome: "hit",
    target: "expiryHit",
  });
  a = apply(a, "linkOutcome", {
    operation: "redirect",
    stepId: "near-get",
    outcome: "error",
    target: "get",
  });
  a = apply(a, "addStep", {
    operation: "redirect",
    id: "near-set",
    step: { type: "call", target: "near", action: "cache.set", entity: "Link", ttlSec: 10 },
    attach: { to: "outcome", stepId: "get", outcome: "hit" },
    continueWith: { outcome: "ok" },
  });
  return apply(a, "linkOutcome", {
    operation: "redirect",
    stepId: "near-set",
    outcome: "error",
    target: "expiryHit",
  });
}

describe("hot keys", () => {
  it("load the one shard that holds the key", () => {
    const redis = simulate(shardedDesign(), 400_000).components.get("redis");

    // 120,000 hot lookups on one shard of 150,000/s, plus a quarter of the rest.
    expect(redis?.utilization).toBeLessThan(1);
    expect(redis?.hottestShardUtilization).toBeGreaterThan(1.2);
  });

  it("are absorbed by a near cache in the service", () => {
    const metrics = simulate(withNearCache(shardedDesign()), 400_000);
    const near = metrics.caches.find((c) => c.componentId === "near");

    expect(metrics.components.get("redis")?.hottestShardUtilization).toBeLessThan(0.7);
    expect(near?.hitRatio).toBeGreaterThan(0.3);
  });
});

describe("autoscaling", () => {
  it("adds instances until utilisation is back at the target", () => {
    const scaled = apply(cacheAsideAttempt(), "setAutoscale", {
      id: "api",
      autoscale: { max: 200, targetUtilization: 0.7 },
    });

    const api = simulate(scaled, 30_000).components.get("api");

    // 30,000 requests at 3,000 per instance and 70% target: 14.3, so 15 instances.
    expect(api?.instances).toBe(15);
    expect(api?.utilization).toBeCloseTo(30_000 / 45_000, 6);
  });

  it("stops at its maximum", () => {
    const capped = apply(cacheAsideAttempt(), "setAutoscale", {
      id: "api",
      autoscale: { max: 8, targetUtilization: 0.7 },
    });

    const api = simulate(capped, 30_000).components.get("api");

    expect(api?.instances).toBe(8);
    expect(api?.utilization).toBeGreaterThan(1);
  });
});
