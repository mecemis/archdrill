import { applyCommand, WorkloadSchema } from "@archdrill/model";
import { cacheAsideAttempt, createLinkAttempt, disableLinkAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { runCheck, runCheckWithLoad } from "../test-support";

describe("invalidation-on-write", () => {
  const params = {
    operation: "disable-link",
    readOperation: "redirect",
    entity: "Link",
    maxStalenessSec: 60,
  };

  it("accepts deleting the cached entry after storing the change", () => {
    expect(
      runCheck("invalidation-on-write", params, disableLinkAttempt("delete-after-update")).status,
    ).toBe("pass");
  });

  it("explains the race when the entry is deleted before the store is updated", () => {
    const outcome = runCheck(
      "invalidation-on-write",
      params,
      disableLinkAttempt("delete-before-update"),
    );

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toBe(
      "Redis is deleted before the store is updated: a read in between caches the old version again, which is then served for up to 60 min; the budget is 60 s.",
    );
  });

  it("flags a long TTL without invalidation, and accepts a short one", () => {
    const stale = runCheck("invalidation-on-write", params, disableLinkAttempt("none"));
    const short = applyCommand(disableLinkAttempt("none"), "updateStep", {
      operation: "redirect",
      stepId: "populate",
      ttlSec: 30,
    }).attempt;

    expect(stale.message).toBe(
      "Redis keeps serving the old version for up to 60 min; the budget is 60 s.",
    );
    expect(runCheck("invalidation-on-write", params, short).status).toBe("pass");
  });

  it("is not applicable before the write is recorded", () => {
    expect(runCheck("invalidation-on-write", params, cacheAsideAttempt()).status).toBe("n/a");
  });
});

describe("no-acknowledged-data-loss", () => {
  const workload = WorkloadSchema.parse({
    operations: { "create-link": { entity: "Link", classes: [{ id: "generated", share: 1 }] } },
    keys: { Link: { existing: { distribution: "zipf", s: 1, population: 1e6 } } },
    environments: [
      {
        id: "failover",
        label: "Failover",
        rates: { "create-link": 3000 },
        faults: [{ kind: "failover", target: { holds: "Link" } }],
      },
    ],
  });
  const params = {
    operation: "create-link",
    environment: "failover",
    decision: "replication-mode",
  };
  const decided = (option: string) =>
    applyCommand(createLinkAttempt("kgs", 1000), "setDecision", {
      decision: "replication-mode",
      option,
    }).attempt;

  it("counts the links async replication loses on failover", () => {
    const outcome = runCheckWithLoad(
      "no-acknowledged-data-loss",
      params,
      decided("async"),
      workload,
    );

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toBe(
      "Postgres replicates asynchronously: writes acknowledged in the last 1 s before the failover (about 3,000 at Failover) are lost.",
    );
  });

  it("asks for a decision before assuming the default", () => {
    const outcome = runCheckWithLoad(
      "no-acknowledged-data-loss",
      params,
      createLinkAttempt("kgs", 1000),
      workload,
    );

    expect(outcome.message).toMatch(/^You have not decided how Postgres replicates writes\./);
  });

  it("treats a store without replicas as a durability risk", () => {
    const single = applyCommand(decided("semi-sync"), "updateComponent", {
      id: "db",
      replicas: 1,
    }).attempt;

    const outcome = runCheckWithLoad("no-acknowledged-data-loss", params, single, workload);

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(/^Postgres has no replica: if its primary's disk is lost/);
  });

  describe("when the primary region is lost", () => {
    const regionLost = WorkloadSchema.parse({
      ...workload,
      environments: [
        {
          id: "region-loss",
          label: "Region lost",
          rates: { "create-link": 3000 },
          faults: [{ kind: "region-down" }],
        },
      ],
    });
    const regionParams = { ...params, environment: "region-loss" };
    const withStandby = (attempt = decided("semi-sync")) =>
      ["lb", "api", "kgs", "db"].reduce(
        (a, id) =>
          a.architecture.components.some((c) => c.id === id)
            ? applyCommand(a, "updateComponent", { id, regions: 2 }).attempt
            : a,
        attempt,
      );

    it("loses everything a store held when it ran only there", () => {
      const outcome = runCheckWithLoad(
        "no-acknowledged-data-loss",
        regionParams,
        decided("semi-sync"),
        regionLost,
      );

      expect(outcome.status).toBe("fail");
      expect(outcome.message).toMatch(/^Postgres ran only in the lost region: every write it held/);
    });

    it("loses the writes not yet replicated to the standby region, even with semi-sync", () => {
      const outcome = runCheckWithLoad(
        "no-acknowledged-data-loss",
        regionParams,
        withStandby(),
        regionLost,
      );

      expect(outcome.status).toBe("fail");
      expect(outcome.message).toBe(
        "Postgres replicates to the standby region asynchronously: writes acknowledged in the last 1 s before the region was lost (about 3,000 at Region lost) are lost.",
      );
    });

    it("passes when the scenario accepts losing that second", () => {
      const outcome = runCheckWithLoad(
        "no-acknowledged-data-loss",
        { ...regionParams, maxLossSec: 1 },
        withStandby(),
        regionLost,
      );

      expect(outcome.status).toBe("pass");
    });
  });

  it("passes when writes wait for a replica", () => {
    const outcome = runCheckWithLoad(
      "no-acknowledged-data-loss",
      params,
      decided("semi-sync"),
      workload,
    );

    expect(outcome).toMatchObject({
      status: "pass",
      message:
        "No acknowledged write is lost: Postgres waits for a replica before acknowledging (semi-sync).",
    });
  });
});

describe("decision-excludes", () => {
  const params = {
    decision: "redirect-status",
    forbidden: [
      {
        option: "s301",
        reason: "browsers cache permanent redirects, so a disabled link keeps redirecting.",
      },
    ],
  };
  const choose = (option: string) =>
    applyCommand(cacheAsideAttempt(), "setDecision", { decision: "redirect-status", option })
      .attempt;

  it("fails a forbidden option with its reason, and passes the others", () => {
    expect(runCheck("decision-excludes", params, choose("s301")).message).toBe(
      'You chose "301": browsers cache permanent redirects, so a disabled link keeps redirecting.',
    );
    expect(runCheck("decision-excludes", params, choose("s302")).status).toBe("pass");
  });

  it("gives half credit until the candidate decides", () => {
    expect(runCheck("decision-excludes", params, cacheAsideAttempt())).toMatchObject({
      status: "partial",
      fraction: 0.5,
    });
  });
});
