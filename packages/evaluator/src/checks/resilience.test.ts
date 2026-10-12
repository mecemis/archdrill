import { type Attempt, applyCommand, type CommandArgs, WorkloadSchema } from "@archdrill/model";
import { cacheAsideAttempt, createLinkAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { runCheck, runCheckWithLoad } from "../test-support";

function withPolicy(
  id: string,
  policy: Omit<CommandArgs<"setConnectionPolicy">, "id">,
  base = cacheAsideAttempt(),
): Attempt {
  return applyCommand(base, "setConnectionPolicy", { id, ...policy }).attempt;
}

describe("dependency-timeout-bounded", () => {
  const params = { capability: "volatile-kv", maxMs: 50 };

  it("flags a cache call without a timeout", () => {
    const outcome = runCheck("dependency-timeout-bounded", params, cacheAsideAttempt());

    expect(outcome.status).toBe("fail");
    expect(outcome.details).toEqual([
      "Redis: no timeout, so a hung call waits for the client default (30 s)",
    ]);
    expect(outcome.evidence).toEqual([{ type: "connection", connectionId: "api--redis" }]);
  });

  it("passes a short timeout and flags a long one", () => {
    expect(
      runCheck("dependency-timeout-bounded", params, withPolicy("api--redis", { timeoutMs: 30 }))
        .status,
    ).toBe("pass");
    expect(
      runCheck("dependency-timeout-bounded", params, withPolicy("api--redis", { timeoutMs: 500 }))
        .details,
    ).toEqual(["Redis: waits up to 500 ms"]);
  });

  it("is not applicable without such a dependency", () => {
    expect(
      runCheck(
        "dependency-timeout-bounded",
        { capability: "id-generation", maxMs: 50 },
        cacheAsideAttempt(),
      ).status,
    ).toBe("n/a");
  });
});

describe("retries-bounded-with-jitter", () => {
  it("accepts designs that do not retry", () => {
    expect(runCheck("retries-bounded-with-jitter", {}, cacheAsideAttempt()).status).toBe("pass");
  });

  it("names unbounded, unspaced and synchronised retries", () => {
    const hammer = withPolicy("api--db", { retries: 10, backoff: "none" });
    const lockstep = withPolicy("api--redis", { retries: 2, jitter: false }, hammer);

    const outcome = runCheck("retries-bounded-with-jitter", {}, lockstep);

    expect(outcome.status).toBe("fail");
    expect(outcome.details).toEqual([
      "Redis: no jitter",
      "Postgres: 10 retries (more than 3), no backoff",
    ]);
  });
});

describe("retry-only-idempotent", () => {
  it("flags a retried conditional insert", () => {
    const retried = withPolicy("api--db", { retries: 2 }, createLinkAttempt("kgs"));

    const outcome = runCheck("retry-only-idempotent", { operation: "create-link" }, retried);

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(/^Postgres · insert if absent is retried\. A timed-out insert/);
  });

  it("allows retrying reads", () => {
    const retried = withPolicy("api--db", { retries: 2 });

    expect(runCheck("retry-only-idempotent", { operation: "redirect" }, retried).status).toBe(
      "pass",
    );
  });
});

describe("circuit-breaker-on-dependency", () => {
  it("looks for a breaker on every call to the dependency", () => {
    const params = { capability: "volatile-kv" };

    expect(runCheck("circuit-breaker-on-dependency", params, cacheAsideAttempt()).status).toBe(
      "fail",
    );
    expect(
      runCheck(
        "circuit-breaker-on-dependency",
        params,
        withPolicy("api--redis", { circuitBreaker: true }),
      ).status,
    ).toBe("pass");
  });
});

describe("stable-under-retries", () => {
  const workload = WorkloadSchema.parse({
    operations: { redirect: { entity: "Link", classes: [{ id: "live", share: 1 }] } },
    keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
    environments: [
      {
        id: "cache-down",
        label: "Cache down",
        rates: { redirect: 60_000 },
        faults: [{ kind: "down", target: { capability: "volatile-kv" } }],
      },
    ],
  });
  const big = applyCommand(cacheAsideAttempt(), "updateComponent", {
    id: "api",
    replicas: 40,
  }).attempt;
  const params = { environment: "cache-down" };

  it("flags retries that keep an overloaded store overloaded", () => {
    const outcome = runCheckWithLoad(
      "stable-under-retries",
      params,
      withPolicy("api--db", { retries: 3 }, big),
      workload,
    );

    expect(outcome.status).toBe("fail");
    expect(outcome.evidence).toEqual([{ type: "component", componentId: "db" }]);
    expect(outcome.details[0]).toMatch(
      /^Postgres: \d+% of its load is retries; retries keep it overloaded$/,
    );
  });

  it("explains a retry storm a shock leaves the design stuck in", () => {
    const steady = WorkloadSchema.parse({
      ...workload,
      environments: [{ id: "peak", label: "Peak", rates: { redirect: 200_000 } }],
    });
    const huge = applyCommand(cacheAsideAttempt(), "updateComponent", {
      id: "api",
      replicas: 80,
    }).attempt;
    const hammer = withPolicy("api--db", { timeoutMs: 200, retries: 10, backoff: "none" }, huge);

    const outcome = runCheckWithLoad(
      "stable-under-retries",
      { environment: "peak" },
      hammer,
      steady,
    );

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(
      /^A shock such as a cache flush tips Postgres into an overload/,
    );
    expect(outcome.details[0]).toMatch(
      /^Postgres: stays at \d+% utilisation, \d+% of its load retries$/,
    );
  });

  it("does not blame retries for overload they do not cause", () => {
    expect(runCheckWithLoad("stable-under-retries", params, big, workload).status).toBe("pass");
  });
});
