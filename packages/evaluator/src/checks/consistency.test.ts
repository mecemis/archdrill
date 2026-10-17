import { type Attempt, applyCommand, type CommandName, WorkloadSchema } from "@archdrill/model";
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

describe("read-your-writes", () => {
  const params = {
    writeOperation: "create-link",
    readOperation: "redirect",
    entity: "Link",
    decision: "replication-mode",
  };
  const apply = (attempt: Attempt, name: CommandName, args: unknown) =>
    applyCommand(attempt, name, args as never).attempt;
  const decided = (attempt: Attempt, option: string) =>
    apply(attempt, "setDecision", { decision: "replication-mode", option });
  /** Every create fills the cache with the new link once it is stored. */
  const primed = (attempt: Attempt) => {
    const added = apply(attempt, "addStep", {
      operation: "create-link",
      id: "prime",
      step: { type: "call", target: "redis", action: "cache.set", entity: "Link", ttlSec: 3600 },
      attach: { to: "outcome", stepId: "insert", outcome: "ok" },
      continueWith: { outcome: "ok" },
    });
    return ["insert-alias:ok", "prime:error"].reduce((a, link) => {
      const [stepId, outcome] = link.split(":");
      return apply(a, "linkOutcome", {
        operation: "create-link",
        stepId,
        outcome,
        target: stepId === "prime" ? "r201" : "prime",
      });
    }, added);
  };

  it("names the replica a redirect can read before it has a new link", () => {
    const outcome = runCheck("read-your-writes", params, createLinkAttempt("kgs", 1000));

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toBe(
      "Redirect can read Postgres within about 1 s of create link without seeing the new Link: its replicas apply writes after the primary has acknowledged them. It answers 404.",
    );
  });

  it("says how long a negative cache keeps the wrong answer", () => {
    const attempt = apply(createLinkAttempt("kgs", 1000), "addStep", {
      operation: "redirect",
      id: "negative",
      step: {
        type: "call",
        target: "redis",
        action: "cache.setNegative",
        entity: "Link",
        ttlSec: 60,
      },
      attach: { to: "outcome", stepId: "read", outcome: "notFound" },
      continueWith: { outcome: "ok" },
    });

    expect(runCheck("read-your-writes", params, attempt).message).toMatch(
      /It answers 404, and the negative cache keeps that answer for 60 s\.$/,
    );
  });

  it("passes when every replica applies a write before it is acknowledged", () => {
    const outcome = runCheck(
      "read-your-writes",
      params,
      decided(createLinkAttempt("kgs", 1000), "sync"),
    );

    expect(outcome).toMatchObject({
      status: "pass",
      message: "Postgres answers every read with the latest acknowledged write.",
    });
  });

  it("still fails with semi-synchronous replication, which does not wait for replicas to apply", () => {
    const outcome = runCheck(
      "read-your-writes",
      params,
      decided(createLinkAttempt("kgs", 1000), "semi-sync"),
    );

    expect(outcome.message).toMatch(/replicas may not have applied it yet/);
  });

  it("passes when every create fills the cache that redirects look in first", () => {
    const outcome = runCheck("read-your-writes", params, primed(createLinkAttempt("kgs", 1000)));

    expect(outcome.message).toBe(
      "A read right after a create finds it: Create link fills Redis before answering, and redirect looks there first.",
    );
  });

  it("fails when one create answers without filling the cache", () => {
    // Only generated codes fill Redis; a custom alias answers 201 straight after its insert.
    const partly = apply(createLinkAttempt("kgs", 1000), "addStep", {
      operation: "create-link",
      id: "prime",
      step: { type: "call", target: "redis", action: "cache.set", entity: "Link", ttlSec: 3600 },
      attach: { to: "outcome", stepId: "insert", outcome: "ok" },
      continueWith: { outcome: "ok" },
    });

    expect(runCheck("read-your-writes", params, partly).status).toBe("fail");
  });

  it("passes when a 404 is answered only after a consistent read", () => {
    // An eventual read first, then the primary before answering 404.
    const fallback = apply(createLinkAttempt("kgs", 1000), "addStep", {
      operation: "redirect",
      id: "read-primary",
      step: { type: "call", target: "db", action: "store.read", entity: "Link", consistent: true },
      attach: { to: "outcome", stepId: "read", outcome: "notFound" },
      continueWith: { outcome: "notFound" },
    });
    const linked = apply(fallback, "linkOutcome", {
      operation: "redirect",
      stepId: "read-primary",
      outcome: "found",
      target: "expiryDb",
    });

    expect(runCheck("read-your-writes", params, linked).message).toBe(
      'A read right after a create finds it: Redirect never answers "not found" from a copy that can lag.',
    );
  });

  it("fails when a create answers before anything stores the link", () => {
    // The create publishes the link and answers; a consumer would store it later.
    const steps: [string, unknown][] = [
      [
        "addComponent",
        {
          id: "events",
          kind: "queue",
          flavor: "managed-queue",
          label: "Link events",
          position: { x: 0, y: 0 },
        },
      ],
      ["addConnection", { from: "api", to: "events" }],
      ["createFlow", { operation: "create-link", handler: "api" }],
      [
        "addStep",
        {
          operation: "create-link",
          id: "publish",
          step: { type: "call", target: "events", action: "queue.publish", event: "link-created" },
          attach: { to: "root" },
        },
      ],
      [
        "addStep",
        {
          operation: "create-link",
          id: "r201",
          step: { type: "respond", status: 201 },
          attach: { to: "outcome", stepId: "publish", outcome: "ok" },
        },
      ],
    ];
    const asyncCreate = steps.reduce(
      (a, [name, args]) => apply(a, name as CommandName, args),
      cacheAsideAttempt(),
    );

    const outcome = runCheck("read-your-writes", params, asyncCreate);

    expect(outcome.message).toBe(
      "Redirect can look for a new Link before anything has stored it: create link answers once it has published the Link, and a consumer stores it later. It answers 404.",
    );
  });

  it("does not apply before anything creates the entity", () => {
    expect(runCheck("read-your-writes", params, cacheAsideAttempt()).status).toBe("n/a");
  });

  it("passes when the redirect reads the primary before answering 404", () => {
    const attempt = apply(createLinkAttempt("kgs", 1000), "updateStep", {
      operation: "redirect",
      stepId: "read",
      consistent: true,
    });

    expect(runCheck("read-your-writes", params, attempt).status).toBe("pass");
  });
});

describe("unique-across-regions", () => {
  const params = { operation: "create-link", entity: "Link", decision: "region-mode" };
  const apply = (attempt: Attempt, name: CommandName, args: unknown) =>
    applyCommand(attempt, name, args as never).attempt;
  /** Creates in both regions, against a store in both, with both regions taking traffic. */
  const bothRegions = (attempt: Attempt, mode = "active-active") =>
    apply(
      ["api", "db"].reduce((a, id) => apply(a, "updateComponent", { id, regions: 2 }), attempt),
      "setDecision",
      { decision: "region-mode", option: mode },
    );
  /** The links in DynamoDB, which takes writes in every region. */
  const onDynamo = (attempt: Attempt): Attempt => ({
    ...attempt,
    architecture: {
      ...attempt.architecture,
      components: attempt.architecture.components.map((c) =>
        c.id === "db"
          ? {
              ...c,
              kind: "key-value-db",
              flavor: "dynamodb",
              label: "Links table",
              size: "on-demand",
              replicas: 1,
            }
          : c,
      ),
    },
  });
  const homeFor = (attempt: Attempt, stepIds: readonly string[]) =>
    stepIds.reduce(
      (a, stepId) => apply(a, "updateStep", { operation: "create-link", stepId, homeRegion: true }),
      attempt,
    );

  it("does not apply while only one region takes creates", () => {
    const outcome = runCheck(
      "unique-across-regions",
      params,
      bothRegions(onDynamo(createLinkAttempt("kgs", 1000)), "active-passive"),
    );

    expect(outcome.status).toBe("n/a");
  });

  it("fails when a global table checks aliases in each region on its own", () => {
    const outcome = runCheck(
      "unique-across-regions",
      params,
      bothRegions(onDynamo(createLinkAttempt("kgs", 1000))),
    );

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toBe(
      "Both regions take creates, and Links table checks a new Link against its own region's copy only, so two people who ask for the same alias in different regions within about a second of each other both get it. The store keeps the last write: one Link silently replaces the other.",
    );
  });

  it("passes when every create writes in the home region", () => {
    const home = ["insert", "insert-alias"].reduce(
      (a, stepId) => apply(a, "updateStep", { operation: "create-link", stepId, homeRegion: true }),
      bothRegions(onDynamo(createLinkAttempt("kgs", 1000))),
    );

    expect(runCheck("unique-across-regions", params, home).status).toBe("pass");
  });

  it("lets random codes be checked in each region, once aliases go home", () => {
    const outcome = runCheck(
      "unique-across-regions",
      params,
      homeFor(bothRegions(onDynamo(createLinkAttempt("random"))), ["insert-alias"]),
    );

    expect(outcome.status).toBe("pass");
    expect(outcome.message).toMatch(
      /random, and two regions drawing the same one within a second is negligible/,
    );
  });

  it("fails when a key service in each region hands out the same codes", () => {
    const kgsInBoth = apply(
      homeFor(bothRegions(onDynamo(createLinkAttempt("kgs", 1000))), ["insert-alias"]),
      "updateComponent",
      { id: "kgs", regions: 2 },
    );

    expect(runCheck("unique-across-regions", params, kgsInBoth).message).toMatch(
      /the key service in each region hands out codes from the same ranges/,
    );
  });

  it("passes when the store runs in the primary region only", () => {
    const oneRegionStore = apply(
      bothRegions(onDynamo(createLinkAttempt("kgs", 1000))),
      "updateComponent",
      { id: "db", regions: 1 },
    );

    expect(runCheck("unique-across-regions", params, oneRegionStore).status).toBe("pass");
  });

  it("does not apply without a create flow", () => {
    expect(runCheck("unique-across-regions", params, bothRegions(cacheAsideAttempt())).status).toBe(
      "n/a",
    );
  });

  it("passes when the store takes writes at one primary", () => {
    const outcome = runCheck(
      "unique-across-regions",
      params,
      bothRegions(createLinkAttempt("kgs", 1000)),
    );

    expect(outcome.status).toBe("pass");
  });
});
