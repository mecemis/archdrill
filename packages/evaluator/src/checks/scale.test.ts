import { applyCommand, WorkloadSchema } from "@archdrill/model";
import { cacheAsideAttempt, disableLinkAttempt, withNearCache } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { runCheck, runCheckWithLoad } from "../test-support";

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
  environments: [{ id: "spike", label: "Spike", rates: { redirect: 400_000 } }],
});

const big = applyCommand(cacheAsideAttempt(), "updateComponent", {
  id: "api",
  replicas: 150,
}).attempt;
const sharded = applyCommand(big, "updateComponent", {
  id: "redis",
  shards: 4,
  replicas: 1,
}).attempt;

describe("utilization-below with a hot key", () => {
  it("names the hottest shard, not the tier average", () => {
    const outcome = runCheckWithLoad(
      "utilization-below",
      { environment: "spike", max: 0.85 },
      sharded,
      viral,
    );

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toBe(
      "Postgres and Redis's hottest shard are over capacity at Spike and reject requests.",
    );
    expect(outcome.details.find((d) => d.startsWith("Redis"))).toMatch(
      /^Redis: its hottest shard at \d+\.\d% while the tier averages \d+\.\d%; one hot key lands on one shard$/,
    );
  });

  it("is relieved by a near cache that absorbs the hot key", () => {
    const outcome = runCheckWithLoad(
      "utilization-below",
      { environment: "spike", max: 0.85 },
      withNearCache(sharded),
      viral,
    );

    expect(outcome.details.some((d) => d.startsWith("Redis"))).toBe(false);
  });
});

describe("overprovisioned", () => {
  it("estimates what idle instances cost", () => {
    const quiet = WorkloadSchema.parse({
      ...viral,
      environments: [{ id: "avg", label: "Average", rates: { redirect: 6000 } }],
    });
    const fleet = applyCommand(cacheAsideAttempt(), "updateComponent", {
      id: "api",
      replicas: 30,
    }).attempt;

    const outcome = runCheckWithLoad("overprovisioned", { environment: "avg" }, fleet, quiet);

    expect(outcome.status).toBe("partial");
    expect(outcome.details[0]).toMatch(
      /^Link API: 30 instances at 7% utilisation; about 4 would do, saving \$[\d,]+\/month$/,
    );
  });
});

describe("autoscaling-configured", () => {
  it("asks request handlers to scale with load", () => {
    const scaled = applyCommand(cacheAsideAttempt(), "setAutoscale", {
      id: "api",
      autoscale: { max: 100, targetUtilization: 0.6 },
    }).attempt;

    expect(runCheck("autoscaling-configured", {}, cacheAsideAttempt()).message).toBe(
      "Link API runs a fixed number of instances.",
    );
    expect(runCheck("autoscaling-configured", {}, scaled).status).toBe("pass");
  });
});

describe("targetKind matcher", () => {
  it("finds calls to a kind of component", () => {
    const params = { operation: "redirect", statuses: [302], step: { targetKind: "near-cache" } };

    expect(runCheck("all-success-paths-contain", params, cacheAsideAttempt()).status).toBe("fail");
    expect(
      runCheck("all-success-paths-contain", params, withNearCache(cacheAsideAttempt())).status,
    ).toBe("pass");
  });
});

describe("invalidation with a near cache", () => {
  const params = {
    operation: "disable-link",
    readOperation: "redirect",
    entity: "Link",
    maxStalenessSec: 60,
  };

  it("only accepts a short TTL, since a delete reaches one instance", () => {
    const short = withNearCache(disableLinkAttempt("delete-after-update"), 10);
    const long = withNearCache(disableLinkAttempt("delete-after-update"), 600);

    expect(runCheck("invalidation-on-write", params, short).status).toBe("pass");
    expect(runCheck("invalidation-on-write", params, long).message).toBe(
      "Near cache keeps a copy in every instance, and a delete reaches only one of them; the others serve the old version for up to 10 min; the budget is 60 s.",
    );
  });
});
