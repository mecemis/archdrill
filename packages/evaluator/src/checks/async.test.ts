import { type Attempt, EnvironmentSchema, WorkloadSchema } from "@archdrill/model";
import { asyncAttempt, cacheAsideAttempt, createLinkAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { mutated, runCheck, runCheckWithLoad } from "../test-support";

/** create-link checks the URL before answering: clean → 201, malicious → 400, error → `onError`. */
function syncCheckAttempt(onError: "r201" | "r503"): Attempt {
  let a = mutated(
    "addComponent",
    {
      id: "safety",
      kind: "external-api",
      flavor: "url-safety",
      label: "URL safety",
      size: "quota",
      position: { x: 0, y: 0 },
    },
    createLinkAttempt("kgs"),
  );
  a = mutated("addConnection", { from: "api", to: "safety" }, a);
  a = mutated(
    "addStep",
    {
      operation: "create-link",
      id: "check",
      step: { type: "call", target: "safety", action: "external.check" },
      attach: { to: "outcome", stepId: "insert", outcome: "ok" },
      continueWith: { outcome: "clean" },
    },
    a,
  );
  a = mutated(
    "addStep",
    {
      operation: "create-link",
      id: "r400",
      step: { type: "respond", status: 400 },
      attach: { to: "outcome", stepId: "check", outcome: "malicious" },
    },
    a,
  );
  a = mutated(
    "linkOutcome",
    { operation: "create-link", stepId: "insert-alias", outcome: "ok", target: "check" },
    a,
  );
  return mutated(
    "linkOutcome",
    { operation: "create-link", stepId: "check", outcome: "error", target: onError },
    a,
  );
}

const stopped = (attempt: Attempt) =>
  runCheck("unsafe-content-stopped", { operation: "create-link", entity: "Link" }, attempt);

describe("unsafe-content-stopped", () => {
  it("passes when a consumer of the published event disables flagged links", () => {
    const outcome = stopped(asyncAttempt());

    expect(outcome.status).toBe("pass");
    expect(outcome.message).toMatch(/checked by Scan new link/);
  });

  it("passes when every accepted link was checked before the create answered", () => {
    const outcome = stopped(syncCheckAttempt("r503"));

    expect(outcome.status).toBe("pass");
    expect(outcome.message).toMatch(/before the create answers/);
  });

  it("gives partial credit when a failed check lets the link through unchecked", () => {
    const outcome = stopped(syncCheckAttempt("r201"));

    expect(outcome.status).toBe("partial");
    expect(outcome.message).toMatch(/never checked, for example when the check fails/);
  });

  it("fails when nothing checks new links", () => {
    expect(stopped(createLinkAttempt("kgs")).status).toBe("fail");
  });

  it("fails when the event is published but the consumer ignores the verdict", () => {
    const ignored = mutated(
      "linkOutcome",
      { operation: "scan-link", stepId: "check", outcome: "malicious", target: "done" },
      asyncAttempt(),
    );

    const outcome = stopped(ignored);

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(/no consumer of it disables a flagged link/);
  });
});

describe("local threat lists", () => {
  const confirmed = (attempt: Attempt) => runCheck("list-matches-confirmed", {}, attempt);
  const unconfirmed = () =>
    mutated(
      "linkOutcome",
      { operation: "scan-link", stepId: "match", outcome: "match", target: "disable" },
      asyncAttempt({ localList: true }),
    );

  it("count a URL that matches nothing on the list as checked", () => {
    const outcome = stopped(asyncAttempt({ localList: true }));

    expect(outcome.status).toBe("pass");
    expect(outcome.message).toMatch(/checked by Scan new link/);
  });

  it("pass when every match is confirmed with the URL-safety API", () => {
    expect(confirmed(asyncAttempt({ localList: true })).status).toBe("pass");
  });

  it("fail when a match is acted on without asking the API", () => {
    const outcome = confirmed(unconfirmed());

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(/without confirming it/);
    expect(outcome.evidence).toContainEqual(expect.objectContaining({ operation: "scan-link" }));
  });

  it("still stop unsafe links when matches are disabled unconfirmed", () => {
    expect(stopped(unconfirmed()).status).toBe("pass");
  });

  it("do not apply to a design that asks the API about every URL", () => {
    expect(confirmed(asyncAttempt()).status).toBe("n/a");
  });
});

describe("backlog-stable", () => {
  const workload = (rates: Record<string, number>) =>
    WorkloadSchema.parse({
      operations: {
        "create-link": { entity: "Link", classes: [{ id: "generated", share: 1 }] },
        "purge-expired": { entity: "Link", classes: [{ id: "expired", share: 1, expired: true }] },
      },
      keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
      environments: [EnvironmentSchema.parse({ id: "peak", label: "Peak", rates })],
    });
  const heavy = workload({ "create-link": 1000, "purge-expired": 4000 });

  it("passes when every consumer and job keeps up", () => {
    const outcome = runCheckWithLoad(
      "backlog-stable",
      { environment: "peak" },
      asyncAttempt({ workers: 3 }),
      heavy,
    );

    expect(outcome.status).toBe("pass");
  });

  it("fails and names what falls behind when workers are saturated", () => {
    const outcome = runCheckWithLoad(
      "backlog-stable",
      { environment: "peak" },
      asyncAttempt({ workers: 1 }),
      heavy,
    );

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(/Purge expired links, Scan new link cannot keep up/);
    expect(outcome.details[0]).toMatch(/arrive, .* more than it processes/);
  });

  it("does not apply to a design with nothing in the background", () => {
    const outcome = runCheckWithLoad(
      "backlog-stable",
      { environment: "peak" },
      cacheAsideAttempt(),
      workload({ redirect: 1000 }),
    );

    expect(outcome.status).toBe("n/a");
  });
});

describe("status-for-condition with a decision", () => {
  const params = {
    operation: "redirect",
    when: { hasStep: { logic: "checkExpiry", outcome: "expired" } },
    decision: "expired-status",
  };

  it("expects the status the decision chose", () => {
    const decided = (option: string) =>
      runCheck(
        "status-for-condition",
        params,
        mutated("setDecision", { decision: "expired-status", option }),
      ).status;

    expect(decided("410")).toBe("pass");
    expect(decided("404")).toBe("fail");
  });

  it("asks for the decision before judging the paths", () => {
    const outcome = runCheck("status-for-condition", params, cacheAsideAttempt());

    expect(outcome.status).toBe("partial");
    expect(outcome.message).toMatch(/Not decided yet: What does an expired link return\?/);
  });
});

describe("decision-excludes with a condition", () => {
  const params = {
    decision: "redirect-status",
    when: { decision: "code-reuse", options: ["after-grace"] },
    forbidden: [{ option: "s301", reason: "browsers cache it for good." }],
  };
  const withDecisions = (reuse: string) =>
    mutated(
      "setDecision",
      { decision: "code-reuse", option: reuse },
      mutated("setDecision", { decision: "redirect-status", option: "s301" }),
    );

  it("applies only when the other decision went that way", () => {
    expect(runCheck("decision-excludes", params, withDecisions("never")).status).toBe("n/a");

    const outcome = runCheck("decision-excludes", params, withDecisions("after-grace"));

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toBe(
      'You chose "301" together with "After a grace period": browsers cache it for good.',
    );
  });
});
