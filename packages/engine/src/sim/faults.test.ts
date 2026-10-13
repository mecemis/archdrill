import {
  type Attempt,
  applyCommand,
  type CommandArgs,
  EnvironmentSchema,
  type Fault,
  FaultSchema,
  WorkloadSchema,
} from "@archdrill/model";
import {
  cacheAsideAttempt,
  createLinkAttempt,
  testCatalogIndex,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { NO_TIMEOUT_WAIT_MS } from "./calls";
import { resolveFaults } from "./faults";
import { simulateEnvironment } from "./simulate";

const workload = WorkloadSchema.parse({
  operations: {
    redirect: { entity: "Link", classes: [{ id: "live", share: 1 }] },
    "create-link": { entity: "Link", classes: [{ id: "generated", share: 1 }] },
  },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
  replication: { decision: "replication-mode" },
  environments: [{ id: "steady", label: "Steady", rates: { redirect: 1 } }],
});

const fault = (input: unknown): Fault => FaultSchema.parse(input);
const cacheDown = (mode: "crash" | "hang") =>
  fault({ kind: "down", target: { capability: "volatile-kv" }, mode });

function simulate(attempt: Attempt, faults: Fault[], rates: Record<string, number>) {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  return simulateEnvironment(
    workload,
    EnvironmentSchema.parse({ id: "env", label: "Env", rates, faults }),
    { attempt, catalog: testCatalogIndex, problem: testProblem, analysis },
  );
}

function redirects(attempt: Attempt, faults: Fault[] = [], rate = 6000) {
  const metrics = simulate(attempt, faults, { redirect: rate });
  const op = metrics.operations.get("redirect");
  if (!op) throw new Error("no redirect metrics");
  return { metrics, op };
}

function apply<N extends Parameters<typeof applyCommand>[1]>(
  attempt: Attempt,
  name: N,
  args: CommandArgs<N>,
): Attempt {
  return applyCommand(attempt, name, args).attempt;
}

const policy = (attempt: Attempt, args: Omit<CommandArgs<"setConnectionPolicy">, "id">) =>
  apply(attempt, "setConnectionPolicy", { id: "api--redis", ...args });

describe("resolveFaults", () => {
  const effect = (attempt: Attempt, f: Fault, id: string) =>
    resolveFaults([f], attempt, testCatalogIndex).get(id);

  it("lets replicas absorb a lost node", () => {
    const lost = effect(
      cacheAsideAttempt(),
      fault({ kind: "down", target: { kind: "cache" }, scope: "one-node" }),
      "redis",
    );

    expect(lost).toMatchObject({ failRead: 0, readCapacity: 0.5, writeCapacity: 1 });
  });

  it("loses a shard's keys when the node had no replica", () => {
    const sharded = apply(cacheAsideAttempt(), "updateComponent", {
      id: "redis",
      replicas: 1,
      shards: 4,
    });

    const lost = effect(
      sharded,
      fault({ kind: "down", target: { kind: "cache" }, scope: "one-node" }),
      "redis",
    );

    expect(lost).toMatchObject({
      failRead: 0.25,
      failWrite: 0.25,
      readCapacity: 0.75,
      writeCapacity: 0.75,
    });
  });

  it("fails writes but not reads while a replicated primary fails over", () => {
    const failover = fault({ kind: "failover", target: { holds: "Link" } });

    expect(effect(cacheAsideAttempt(), failover, "db")).toMatchObject({
      failRead: 0,
      failWrite: 1,
      hang: true,
    });
  });

  it("keeps a store's write capacity when it loses a replica", () => {
    const lost = effect(
      cacheAsideAttempt(),
      fault({ kind: "down", target: { holds: "Link" }, scope: "one-node" }),
      "db",
    );
    const service = effect(
      cacheAsideAttempt(),
      fault({ kind: "down", target: { kind: "service" }, scope: "one-node" }),
      "api",
    );

    expect(lost).toMatchObject({ readCapacity: 0.5, writeCapacity: 1 });
    expect(service).toMatchObject({ readCapacity: 2 / 3, writeCapacity: 2 / 3 });
  });

  it("assumes two partial faults on one component hit the same part", () => {
    const sharded = apply(cacheAsideAttempt(), "updateComponent", {
      id: "db",
      shards: 4,
      replicas: 1,
    });
    const faults = [
      fault({ kind: "down", target: { holds: "Link" }, scope: "one-shard" }),
      fault({ kind: "failover", target: { holds: "Link" } }),
    ];

    expect(resolveFaults(faults, sharded, testCatalogIndex).get("db")).toMatchObject({
      failRead: 0.25,
      failWrite: 0.25,
    });
  });

  it("finds the handler of an operation", () => {
    const crash = fault({ kind: "down", target: { handlerOf: "redirect" }, scope: "one-node" });

    expect([...resolveFaults([crash], cacheAsideAttempt(), testCatalogIndex).keys()]).toEqual([
      "api",
    ]);
  });
});

describe("faults and connection policies", () => {
  it("serves redirects from the store while the cache is down", () => {
    const { metrics, op } = redirects(cacheAsideAttempt(), [cacheDown("crash")]);

    expect(op.successRate).toBeCloseTo(1, 9);
    expect(metrics.components.get("db")?.readLoad).toBeCloseTo(6000, 6);
    expect(metrics.components.get("redis")?.faults).toEqual(["down"]);
  });

  it("makes every request wait for the client default when a cache hangs and nobody set a timeout", () => {
    const { op } = redirects(cacheAsideAttempt(), [cacheDown("hang")]);

    expect(op.latency.p50).toBeGreaterThan(NO_TIMEOUT_WAIT_MS);
  });

  it("bounds the damage with a timeout, and removes it with a circuit breaker", () => {
    const bounded = redirects(policy(cacheAsideAttempt(), { timeoutMs: 50 }), [cacheDown("hang")]);
    const breaker = redirects(
      policy(cacheAsideAttempt(), { timeoutMs: 50, circuitBreaker: true }),
      [cacheDown("hang")],
    );

    // The lookup and the population both wait out the timeout: two × 50 ms.
    expect(bounded.op.latency.p50).toBeGreaterThan(100);
    expect(bounded.op.latency.p99).toBeLessThan(120);
    expect(breaker.op.latency.p99).toBeLessThan(20);
    expect(breaker.metrics.calls.get("api--redis")?.shortCircuit).toBeCloseTo(1, 6);
  });

  it("multiplies the load on an overloaded store with retries", () => {
    const big = apply(cacheAsideAttempt(), "updateComponent", { id: "api", replicas: 40 });
    const retrying = apply(big, "setConnectionPolicy", { id: "api--db", retries: 3 });

    const plain = redirects(big, [cacheDown("crash")], 60_000).metrics.components.get("db");
    const amplified = redirects(retrying, [cacheDown("crash")], 60_000).metrics.components.get(
      "db",
    );

    expect(plain?.retryLoad).toBe(0);
    expect(amplified?.readLoad).toBeGreaterThan(1.5 * (plain?.readLoad ?? 0));
    expect(amplified?.retryLoad).toBeGreaterThan(0.3 * (amplified?.readLoad ?? 0));
  });

  it("caps the load a dependency sees with a bulkhead", () => {
    const big = apply(cacheAsideAttempt(), "updateComponent", { id: "api", replicas: 40 });
    const guarded = apply(big, "setConnectionPolicy", { id: "api--db", maxRps: 15_000 });

    const { metrics, op } = redirects(guarded, [cacheDown("crash")], 60_000);

    expect(metrics.components.get("db")?.readLoad).toBeCloseTo(15_000, -2);
    expect(metrics.components.get("db")?.utilization).toBeLessThan(1);
    expect(metrics.calls.get("api--db")?.shed).toBeCloseTo(0.75, 2);
    expect(op.successRate).toBeCloseTo(0.25, 2);
  });

  it("fails creates while the primary fails over, and keeps redirects working", () => {
    const failover = fault({ kind: "failover", target: { holds: "Link" }, mode: "crash" });

    const metrics = simulate(createLinkAttempt("kgs", 1000), [failover], {
      redirect: 1000,
      "create-link": 100,
    });

    expect(metrics.operations.get("create-link")?.successRate).toBeCloseTo(0, 6);
    expect(metrics.operations.get("redirect")?.successRate).toBeCloseTo(1, 6);
  });

  it("slows writes by waiting for replicas under semi-synchronous replication", () => {
    const p50 = (mode: string) => {
      const attempt = apply(createLinkAttempt("kgs", 1000), "setDecision", {
        decision: "replication-mode",
        option: mode,
      });
      return (
        simulate(attempt, [], { "create-link": 100 }).operations.get("create-link")?.latency.mean ??
        0
      );
    };

    expect(p50("semi-sync") - p50("async")).toBeCloseTo(1, 1);
    expect(p50("sync") - p50("async")).toBeCloseTo(2, 1);
  });

  it("finds the overloaded state aggressive retries can get stuck in", () => {
    const big = apply(cacheAsideAttempt(), "updateComponent", { id: "api", replicas: 80 });
    const hammer = apply(big, "setConnectionPolicy", {
      id: "api--db",
      timeoutMs: 200,
      retries: 10,
      backoff: "none",
    });

    // Warm, the store sees only misses; cold, it sees all 200,000 reads a second.
    const healthy = redirects(big, [], 200_000).metrics;
    const stuck = redirects(hammer, [], 200_000).metrics;

    expect(healthy.metastable).toEqual([]);
    expect(stuck.components.get("db")?.utilization).toBeLessThan(1);
    expect(stuck.metastable.map((c) => c.componentId)).toEqual(["db"]);
    expect(stuck.metastable[0]?.retryLoad).toBeGreaterThan(0.5 * (stuck.metastable[0]?.load ?? 0));
  });
});
