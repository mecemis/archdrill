import { cacheAsideAttempt, createLinkAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { mutated, runCheck } from "../test-support";

const NOT_FOUND_IS_404 = {
  operation: "redirect",
  when: { hasStep: { action: "store.read", outcome: "notFound" } },
  statuses: [404],
};

describe("outcome-handled", () => {
  it("passes when every step that can fail handles the error", () => {
    const outcome = runCheck(
      "outcome-handled",
      { operation: "redirect", outcome: "error" },
      cacheAsideAttempt(),
    );

    expect(outcome.status).toBe("pass");
  });

  it("gives partial credit and points at the exact unhandled step", () => {
    const attempt = mutated("linkOutcome", {
      operation: "redirect",
      stepId: "get",
      outcome: "error",
      target: null,
    });

    const outcome = runCheck(
      "outcome-handled",
      { operation: "redirect", outcome: "error" },
      attempt,
    );

    expect(outcome.status).toBe("partial");
    expect(outcome.fraction).toBeCloseTo(2 / 3);
    expect(outcome.evidence).toEqual([
      { type: "step", operation: "redirect", stepId: "get", outcome: "error" },
    ]);
  });

  it("can be narrowed to one capability", () => {
    const attempt = mutated("linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "error",
      target: null,
    });

    const cacheOnly = runCheck(
      "outcome-handled",
      { operation: "redirect", outcome: "error", match: { capability: "volatile-kv" } },
      attempt,
    );

    expect(cacheOnly.status).toBe("pass");
  });

  it("is not applicable when no step can produce the outcome", () => {
    const outcome = runCheck(
      "outcome-handled",
      { operation: "redirect", outcome: "conflict" },
      cacheAsideAttempt(),
    );

    expect(outcome.status).toBe("n/a");
  });
});

describe("no-path", () => {
  const redirectWithoutRead = {
    operation: "redirect",
    where: {
      all: [
        { statusClass: "3xx" },
        { not: { hasStep: { entity: "Link", outcome: ["hit", "found"] } } },
      ],
    },
  };

  it("passes when every redirect is backed by a read", () => {
    expect(runCheck("no-path", redirectWithoutRead, cacheAsideAttempt()).status).toBe("pass");
  });

  it("fails with the offending path when a miss redirects blindly", () => {
    let attempt = mutated("linkOutcome", {
      operation: "redirect",
      stepId: "get",
      outcome: "miss",
      target: null,
    });
    attempt = mutated(
      "addStep",
      {
        operation: "redirect",
        id: "blind",
        step: { type: "respond", status: 302 },
        attach: { to: "outcome", stepId: "get", outcome: "miss" },
      },
      attempt,
    );
    attempt = mutated("removeStep", { operation: "redirect", stepId: "read" }, attempt);

    const outcome = runCheck("no-path", redirectWithoutRead, attempt);

    expect(outcome.status).toBe("fail");
    expect(outcome.details).toEqual(["#2 miss → 302"]);
    expect(outcome.evidence).toEqual([
      { type: "path", operation: "redirect", pathId: "redirect#2" },
    ]);
  });
});

describe("no-path applicability", () => {
  it("is not applicable when the design does not use the approach", () => {
    const params = {
      operation: "redirect",
      applicableWhen: { hasStep: { action: "cache.setNegative" } },
      where: { hasStep: { action: "store.read", outcome: "notFound" } },
    };

    expect(runCheck("no-path", params, cacheAsideAttempt()).status).toBe("n/a");
  });
});

describe("status-for-condition", () => {
  it("passes when unknown codes answer 404", () => {
    expect(runCheck("status-for-condition", NOT_FOUND_IS_404, cacheAsideAttempt()).status).toBe(
      "pass",
    );
  });

  it("treats an unhandled outcome as a wrong answer", () => {
    const attempt = mutated("linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "notFound",
      target: null,
    });

    const outcome = runCheck("status-for-condition", NOT_FOUND_IS_404, attempt);

    expect(outcome.status).toBe("fail");
    expect(outcome.details).toEqual([
      "#5 miss → notFound → unhandled",
      "#10 error → notFound → unhandled",
    ]);
  });

  it("fails when the wrong status is returned", () => {
    const attempt = mutated("linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "notFound",
      target: "r503",
    });

    expect(runCheck("status-for-condition", NOT_FOUND_IS_404, attempt).status).toBe("fail");
  });

  it("is not applicable when no path reaches the condition", () => {
    const params = { ...NOT_FOUND_IS_404, when: { hasStep: { logic: "validateUrl" } } };

    expect(runCheck("status-for-condition", params, cacheAsideAttempt()).status).toBe("n/a");
  });
});

describe("all-success-paths-contain", () => {
  const expiryChecked = {
    operation: "redirect",
    statuses: [301, 302],
    step: { logic: "checkExpiry", outcome: "valid" },
  };

  it("passes when every redirect checks expiry first", () => {
    expect(runCheck("all-success-paths-contain", expiryChecked, cacheAsideAttempt()).status).toBe(
      "pass",
    );
  });

  it("fails for the paths that skip the expiry check", () => {
    const attempt = mutated("removeStep", {
      operation: "redirect",
      stepId: "expiryHit",
      bypass: "valid",
    });

    const outcome = runCheck("all-success-paths-contain", expiryChecked, attempt);

    expect(outcome.status).toBe("fail");
    expect(outcome.details).toEqual(["#0 hit → 302"]);
  });
});

describe("populate-after-miss", () => {
  const params = { operation: "redirect", entity: "Link" };

  it("passes when the cache is populated after a miss", () => {
    expect(runCheck("populate-after-miss", params, cacheAsideAttempt()).status).toBe("pass");
  });

  it("fails and points at the read step when population is missing", () => {
    const attempt = mutated("removeStep", {
      operation: "redirect",
      stepId: "populate",
      bypass: "ok",
    });

    const outcome = runCheck("populate-after-miss", params, attempt);

    expect(outcome.status).toBe("fail");
    expect(outcome.evidence[0]).toEqual({ type: "step", operation: "redirect", stepId: "read" });
  });

  it("is not applicable without a cache", () => {
    const attempt = mutated("removeStep", { operation: "redirect", stepId: "get", bypass: "miss" });

    expect(runCheck("populate-after-miss", params, attempt).status).toBe("n/a");
  });
});

describe("no-single-point-of-failure", () => {
  const params = { operation: "redirect" };

  it("passes when every critical component is redundant", () => {
    expect(runCheck("no-single-point-of-failure", params, cacheAsideAttempt()).status).toBe("pass");
  });

  it("flags a single service replica", () => {
    const attempt = mutated("updateComponent", { id: "api", replicas: 1 });

    const outcome = runCheck("no-single-point-of-failure", params, attempt);

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toBe("Link API is a single point of failure.");
    expect(outcome.evidence).toEqual([{ type: "component", componentId: "api" }]);
  });

  it("does not require cache redundancy when cache errors fall back to the store", () => {
    const attempt = mutated("updateComponent", { id: "redis", replicas: 1 });

    expect(runCheck("no-single-point-of-failure", params, attempt).status).toBe("pass");
  });

  it("requires cache redundancy when a cache error fails the request", () => {
    let attempt = mutated("updateComponent", { id: "redis", replicas: 1 });
    attempt = mutated(
      "linkOutcome",
      { operation: "redirect", stepId: "get", outcome: "error", target: "r503" },
      attempt,
    );

    const outcome = runCheck("no-single-point-of-failure", params, attempt);

    expect(outcome.evidence).toEqual([{ type: "component", componentId: "redis" }]);
  });
});

describe("no-single-point-of-failure per kind of request", () => {
  it("flags a component that one kind of request cannot do without", () => {
    // Custom aliases never touch the key generator, but generated codes always do.
    const attempt = mutated(
      "updateComponent",
      { id: "kgs", replicas: 1 },
      createLinkAttempt("kgs"),
    );

    const outcome = runCheck("no-single-point-of-failure", { operation: "create-link" }, attempt);

    expect(outcome.evidence).toEqual([{ type: "component", componentId: "kgs" }]);
  });
});

describe("no-single-point-of-failure across zones", () => {
  const params = { operation: "redirect", scope: "zone" };
  const spread = (attempt = cacheAsideAttempt()) =>
    mutated(
      "updateComponent",
      { id: "db", zones: 2 },
      mutated("updateComponent", { id: "api", zones: 3 }, attempt),
    );

  it("counts replicas in one zone as one point of failure, lost together with the rest", () => {
    const outcome = runCheck("no-single-point-of-failure", params, cacheAsideAttempt());

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toBe(
      "Losing an availability zone takes down Link API (down: every instance was in the lost zone); Redis (down: every instance was in the lost zone); Postgres (down: every instance was in the lost zone).",
    );
    expect(outcome.evidence).toEqual([
      { type: "component", componentId: "api" },
      { type: "component", componentId: "redis" },
      { type: "component", componentId: "db" },
    ]);
  });

  it("does not count on a fallback that shares the lost zone", () => {
    // Either the cache or the store alone would do, but one zone takes both.
    const attempt = mutated("updateComponent", { id: "api", zones: 3 });

    const outcome = runCheck("no-single-point-of-failure", params, attempt);

    expect(outcome.evidence).toEqual([
      { type: "component", componentId: "redis" },
      { type: "component", componentId: "db" },
    ]);
  });

  it("passes once everything a redirect needs is spread over zones", () => {
    const outcome = runCheck("no-single-point-of-failure", params, spread());

    expect(outcome.status).toBe("pass");
    expect(outcome.message).toBe(
      "Every kind of request keeps a way to succeed when a zone is lost.",
    );
  });

  it("flags a cache whose replicas share a zone when redirects cannot do without it", () => {
    const attempt = mutated(
      "linkOutcome",
      { operation: "redirect", stepId: "get", outcome: "error", target: "r503" },
      spread(),
    );

    const outcome = runCheck("no-single-point-of-failure", params, attempt);

    expect(outcome.evidence).toEqual([{ type: "component", componentId: "redis" }]);
  });
});

describe("no-single-point-of-failure across regions", () => {
  const params = { operation: "redirect", scope: "region" };
  const standby = (ids: readonly string[]) =>
    ids.reduce(
      (attempt, id) => mutated("updateComponent", { id, regions: 2 }, attempt),
      cacheAsideAttempt(),
    );

  it("names everything that runs only in the primary region", () => {
    const outcome = runCheck("no-single-point-of-failure", params, standby(["api"]));

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toBe(
      "Losing the primary region takes down ALB (runs only in the primary region); Redis (runs only in the primary region); Postgres (runs only in the primary region).",
    );
  });

  it("passes once everything a redirect needs has a standby copy", () => {
    const outcome = runCheck(
      "no-single-point-of-failure",
      params,
      standby(["lb", "api", "redis", "db"]),
    );

    expect(outcome.message).toBe(
      "Every kind of request keeps a way to succeed when the primary region is lost.",
    );
  });

  it("counts on the store behind a cache that runs only in the primary region", () => {
    // A cache miss reads the store, so redirects do without the cache.
    const outcome = runCheck("no-single-point-of-failure", params, standby(["lb", "api", "db"]));

    expect(outcome.status).toBe("pass");
  });
});

describe("unused-components", () => {
  it("lists components no flow uses", () => {
    const attempt = mutated("addComponent", {
      id: "spare",
      kind: "cache",
      flavor: "redis",
      label: "Spare cache",
      position: { x: 0, y: 0 },
    });

    const outcome = runCheck("unused-components", {}, attempt);

    expect(outcome.message).toBe("Spare cache is not used by any flow.");
    expect(outcome.evidence).toEqual([{ type: "component", componentId: "spare" }]);
  });
});
