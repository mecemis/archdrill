import { type Attempt, applyCommand, EnvironmentSchema, WorkloadSchema } from "@archdrill/model";
import { cacheAsideAttempt, pooledCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { callModel, NO_TIMEOUT_WAIT_MS } from "./calls";
import { DEFAULT_POOL_SIZE, poolState } from "./pools";
import { simulateEnvironment } from "./simulate";

const catalog = pooledCatalogIndex;

const workload = WorkloadSchema.parse({
  operations: { redirect: { entity: "Link", classes: [{ id: "live", share: 1 }] } },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
  environments: [{ id: "steady", label: "Steady", rates: { redirect: 6000 } }],
});

/** Every redirect reaches the database: the cache refuses its connections. */
const cacheDown = [{ kind: "down", target: { capability: "volatile-kv" } }];

function simulate(attempt: Attempt, faults: unknown[] = cacheDown) {
  const analysis = analyzeAttempt(attempt, { catalog, problem: testProblem });
  return simulateEnvironment(
    workload,
    EnvironmentSchema.parse({ id: "env", label: "Env", rates: { redirect: 6000 }, faults }),
    { attempt, catalog, problem: testProblem, analysis },
  );
}

const withPool = (attempt: Attempt, poolSize: number) =>
  applyCommand(attempt, "setConnectionPolicy", { id: "api--db", poolSize }).attempt;

/** Three API instances: 30 pooled connections on the primary, over its limit of 25. */
const twoInstances = (attempt: Attempt) =>
  applyCommand(attempt, "updateComponent", { id: "api", replicas: 2 }).attempt;

describe("connection pools", () => {
  it("keeps a pool to each copy it calls, as full as Little's law says", () => {
    const pool = simulate(twoInstances(cacheAsideAttempt())).pools.get("api--db");

    expect(pool).toMatchObject({ poolSize: DEFAULT_POOL_SIZE, copies: 2, callerInstances: 2 });
    // 3,000 reads a second per instance, each holding a connection for the read and the round trip.
    expect(pool?.inFlight).toBeCloseTo((3000 * (pool?.holdMs ?? 0)) / 1000, 6);
    expect(pool?.utilization).toBeCloseTo((pool?.inFlight ?? 0) / 20, 6);
    expect(pool?.exhausted).toBe(0);
  });

  it("leaves calls waiting for a connection, and fails those that wait too long", () => {
    const roomy = simulate(twoInstances(cacheAsideAttempt()));
    const tight = simulate(withPool(twoInstances(cacheAsideAttempt()), 2));
    const pool = tight.pools.get("api--db");

    expect(pool?.utilization).toBeGreaterThan(1);
    expect(pool?.exhausted).toBeCloseTo(1 - 1 / (pool?.utilization ?? 1), 2);
    expect(tight.operations.get("redirect")?.successRate).toBeLessThan(
      (roomy.operations.get("redirect")?.successRate ?? 0) - 0.3,
    );
    // Those that get one waited for it.
    expect(pool?.waitMs).toBeGreaterThan(0);
  });

  it("counts every caller instance's pool against the primary's connection limit", () => {
    const within = simulate(twoInstances(cacheAsideAttempt()));
    const over = simulate(cacheAsideAttempt());

    expect(within.components.get("db")?.connections).toEqual({ open: 20, limit: 25 });
    expect(over.components.get("db")?.connections).toEqual({ open: 30, limit: 25 });
    // The connections beyond the limit are refused, and their requests with them.
    expect(over.components.get("db")?.utilization).toBeCloseTo(1.2, 6);
    expect(over.components.get("db")?.dropRate).toBeGreaterThan(0.1);
  });

  it("lets a proxy hold the pools, for a hop and a price per vCPU", () => {
    // Within its limit when direct, so the store's own latency is the same both ways.
    const direct = simulate(twoInstances(cacheAsideAttempt()), []);
    const proxied = simulate(
      applyCommand(twoInstances(cacheAsideAttempt()), "updateComponent", { id: "db", proxy: true })
        .attempt,
      [],
    );
    const db = proxied.components.get("db");

    expect(db?.connections).toBeNull();
    expect(db?.dropRate).toBe(0);
    expect(proxied.pools.get("api--db")?.proxied).toBe(true);
    // Two instances of 8 vCPUs at $0.015 a vCPU-hour.
    expect(db?.costBreakdown.proxy).toBeCloseTo(0.015 * 8 * 2 * 730, 6);
    expect(proxied.pools.get("api--db")?.holdMs).toBeCloseTo(
      (direct.pools.get("api--db")?.holdMs ?? 0) + 2,
      6,
    );
  });

  it("counts only the instances still running, and their pools", () => {
    const crash = { kind: "down", target: { handlerOf: "redirect" }, scope: "one-node" };
    const oneLeft = simulate(twoInstances(cacheAsideAttempt()), [...cacheDown, crash]);
    const pool = oneLeft.pools.get("api--db");
    const attempts = oneLeft.calls.get("api--db")?.attempts ?? 0;

    expect(pool?.callerInstances).toBe(1);
    // The survivor holds every call that still reaches the database.
    expect(pool?.inFlight).toBeCloseTo((attempts * (pool?.holdMs ?? 0)) / 1000, 6);
    expect(oneLeft.components.get("db")?.connections?.open).toBe(10);
  });

  it("does not queue a store's statements behind its open connections", () => {
    const store = simulate(cacheAsideAttempt()).components.get("db");

    // Over its connection limit, yet the statements it serves wait no longer than before.
    expect(store?.utilization).toBeGreaterThan(1);
    expect(store?.latency.mean).toBeLessThan(3);
  });

  it("ignores stores that serve many calls over each connection", () => {
    const redis = simulate(cacheAsideAttempt(), []).pools;

    expect([...redis.keys()]).toEqual(["api--db"]);
  });
});

describe("poolState", () => {
  const spec = {
    connectionId: "c",
    caller: "api",
    target: "db",
    poolSize: 10,
    copies: 2,
    proxyMs: 0,
  };

  it("finds nothing in flight without calls", () => {
    expect(poolState(spec, 0, 3, 2).utilization).toBe(0);
  });

  it("is full when calls a second times their latency fill every connection", () => {
    // 10,000 calls a second over one instance, 2 ms each: 20 in flight on 20 connections.
    const state = poolState(spec, 10_000, 1, 2);

    expect(state.inFlight).toBeCloseTo(20, 9);
    expect(state.utilization).toBeCloseTo(1, 9);
    expect(poolState(spec, 20_000, 1, 2).exhausted).toBeCloseTo(0.5, 9);
  });
});

describe("callModel with a pool", () => {
  const policy = {
    retries: 0,
    backoff: "exponential" as const,
    jitter: true,
    circuitBreaker: false,
    sameZone: false,
  };
  const risks = { shed: 0, fault: 0, faultHangs: false, overload: 0, timeout: 0 };

  it("fails attempts that find no connection after the pool's wait, without reaching the target", () => {
    const model = callModel({ ...risks, pool: 0.25 }, policy);

    expect(model.failure).toBeCloseTo(0.25, 9);
    expect(model.reachOnFailure).toBe(0);
    expect(model.failureLatency.mean).toBeCloseTo(NO_TIMEOUT_WAIT_MS, 6);
  });

  it("adds the wait for a connection to a call that gets one", () => {
    expect(callModel({ ...risks, poolWaitMs: 3 }, policy).successExtra.mean).toBeCloseTo(3, 9);
  });
});
