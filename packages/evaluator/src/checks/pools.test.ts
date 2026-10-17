import { type Attempt, applyCommand, WorkloadSchema } from "@archdrill/model";
import { cacheAsideAttempt, pooledCatalogIndex } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { runCheckWithLoad } from "../test-support";

/** Every redirect reaches the database: the cache refuses its connections. */
const workload = WorkloadSchema.parse({
  operations: { redirect: { entity: "Link", classes: [{ id: "live", share: 1 }] } },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
  environments: [
    {
      id: "cache-down",
      label: "Cache down",
      rates: { redirect: 6000 },
      faults: [{ kind: "down", target: { capability: "volatile-kv" } }],
    },
  ],
});

const run = (attempt: Attempt) =>
  runCheckWithLoad(
    "connection-pools",
    { environment: "cache-down" },
    attempt,
    workload,
    pooledCatalogIndex,
  );

const apiInstances = (replicas: number) =>
  applyCommand(cacheAsideAttempt(), "updateComponent", { id: "api", replicas }).attempt;

const pool = (attempt: Attempt, poolSize: number) =>
  applyCommand(attempt, "setConnectionPolicy", { id: "api--db", poolSize }).attempt;

describe("connection-pools", () => {
  it("passes while the pools have headroom and fit the store's limit", () => {
    const outcome = run(apiInstances(2));

    expect(outcome.status).toBe("pass");
    expect(outcome.message).toMatch(
      /^The fullest pool is \d+% busy at Cache down\. Postgres holds 20 of the 25 connections each primary accepts\.$/,
    );
  });

  it("fails when every instance's pools together exceed the store's connection limit", () => {
    const outcome = run(apiInstances(3));

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toBe(
      "Postgres would hold 30 connections on each primary at Cache down, over its limit of 25: the pools beyond it are refused, and their requests with them.",
    );
    expect(outcome.details[0]).toBe(
      "Postgres: 3 Link API × 10 = 30 connections on each primary, over its limit of 25; the rest are refused.",
    );
    expect(outcome.evidence).toContainEqual({ type: "component", componentId: "db" });
  });

  it("fails when a pool is too small for the calls in flight, with Little's law", () => {
    const outcome = run(pool(apiInstances(2), 2));

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(
      /^Link API's pools to Postgres are \d+% busy at Cache down: \d+% of its calls find no free connection and wait until they give up\.$/,
    );
    expect(outcome.details[0]).toMatch(
      /^Link API → Postgres: [\d,]+ calls a second per instance × [\d.]+ ms = [\d.]+ in flight, on 4 connections \(2 to each of 2 copies\): \d+% busy; \d+% of its calls find none free/,
    );
    expect(outcome.evidence).toEqual([{ type: "connection", connectionId: "api--db" }]);
  });

  it("gives partial credit to pools busy enough to leave no headroom", () => {
    const outcome = run(pool(apiInstances(2), 4));

    expect(outcome.status).toBe("partial");
    expect(outcome.message).toBe(
      "1 caller's pools run above 80% at Cache down, leaving no headroom for a burst.",
    );
  });

  it("lets a proxy hold the pools instead of the store", () => {
    const proxied = applyCommand(apiInstances(3), "updateComponent", {
      id: "db",
      proxy: true,
    }).attempt;

    expect(run(proxied).status).toBe("pass");
  });

  it("does not apply without a pooled store", () => {
    expect(
      runCheckWithLoad(
        "connection-pools",
        { environment: "cache-down" },
        cacheAsideAttempt(),
        workload,
      ).status,
    ).toBe("n/a");
  });
});
