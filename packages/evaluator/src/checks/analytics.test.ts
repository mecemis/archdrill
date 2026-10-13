import { applyCommand } from "@archdrill/model";
import { asyncAttempt, cacheAsideAttempt, clickAnalyticsAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { runCheck } from "../test-support";

describe("no-sync-write-on-read-path", () => {
  it("passes a redirect that only reads and publishes", () => {
    const outcome = runCheck(
      "no-sync-write-on-read-path",
      { operation: "redirect" },
      clickAnalyticsAttempt(),
    );

    expect(outcome.status).toBe("pass");
  });

  it("fails a redirect that counts the click itself", () => {
    let attempt = cacheAsideAttempt();
    attempt = applyCommand(attempt, "setComponentData", {
      id: "db",
      entities: ["Link", "LinkStats"],
    }).attempt;
    attempt = applyCommand(attempt, "addStep", {
      operation: "redirect",
      id: "count",
      step: { type: "call", target: "db", action: "counter.increment", entity: "LinkStats" },
      attach: { to: "outcome", stepId: "expiryHit", outcome: "valid" },
      continueWith: { outcome: "ok" },
    }).attempt;

    const outcome = runCheck("no-sync-write-on-read-path", { operation: "redirect" }, attempt);

    expect(outcome.status).toBe("fail");
    expect(outcome.evidence).toContainEqual({
      type: "step",
      operation: "redirect",
      stepId: "count",
    });
  });
});

describe("publishes-without-waiting", () => {
  const params = { operation: "redirect", event: "link-clicked", statuses: [301, 302] };

  it("passes a fire-and-forget publish with a bounded buffer", () => {
    expect(runCheck("publishes-without-waiting", params, clickAnalyticsAttempt()).status).toBe(
      "pass",
    );
  });

  it("gives half credit to a publish that waits for the queue", () => {
    const outcome = runCheck(
      "publishes-without-waiting",
      params,
      clickAnalyticsAttempt({ fireAndForget: false }),
    );

    expect(outcome).toMatchObject({ status: "partial", fraction: 0.5 });
  });

  it("takes credit off a buffer without a bound", () => {
    let attempt = clickAnalyticsAttempt();
    attempt = applyCommand(attempt, "updateStep", {
      operation: "redirect",
      stepId: "click",
      bufferSize: null,
    }).attempt;

    const outcome = runCheck("publishes-without-waiting", params, attempt);

    expect(outcome).toMatchObject({ status: "partial", fraction: 0.75 });
  });

  it("fails when nothing publishes the event", () => {
    expect(runCheck("publishes-without-waiting", params, cacheAsideAttempt()).status).toBe("fail");
  });
});

describe("event-consumed", () => {
  const params = { operation: "redirect", event: "link-clicked" };

  it("passes when a consumer handles the published clicks", () => {
    expect(runCheck("event-consumed", params, clickAnalyticsAttempt()).status).toBe("pass");
  });

  it("fails when clicks are published but never consumed", () => {
    const attempt = applyCommand(clickAnalyticsAttempt(), "removeFlow", {
      operation: "record-click",
    }).attempt;

    const outcome = runCheck("event-consumed", params, attempt);

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(/no consumer receives it/);
    expect(outcome.evidence).toContainEqual({ type: "component", componentId: "clicks" });
  });

  it("fails when nothing publishes them", () => {
    const outcome = runCheck("event-consumed", params, cacheAsideAttempt());

    expect(outcome.status).toBe("fail");
    expect(outcome.evidence.length).toBeGreaterThan(0);
  });
});

describe("idempotent-consumer-writes", () => {
  const params = { operation: "record-click" };

  it("fails increments that a redelivery repeats", () => {
    const outcome = runCheck("idempotent-consumer-writes", params, clickAnalyticsAttempt());

    expect(outcome.status).toBe("fail");
    expect(outcome.evidence).toContainEqual({
      type: "step",
      operation: "record-click",
      stepId: "count",
    });
  });

  it("passes increments made only for messages recorded as new", () => {
    const outcome = runCheck(
      "idempotent-consumer-writes",
      params,
      clickAnalyticsAttempt({ store: "dynamodb", dedupe: true }),
    );

    expect(outcome.status).toBe("pass");
  });
});

describe("expired-data-removed", () => {
  const params = { entity: "Link", job: "purge-expired" };

  it("passes a job that deletes expired links", () => {
    expect(runCheck("expired-data-removed", params, asyncAttempt()).status).toBe("pass");
  });

  it("fails when nothing deletes them", () => {
    const attempt = applyCommand(asyncAttempt(), "removeFlow", {
      operation: "purge-expired",
    }).attempt;

    const outcome = runCheck("expired-data-removed", params, attempt);

    expect(outcome.status).toBe("fail");
    expect(outcome.evidence.length).toBeGreaterThan(0);
  });
});

describe("idempotent-consumer-writes with exactly-once commits", () => {
  it("accepts increments committed with the processor's checkpoints", () => {
    const attempt = applyCommand(clickAnalyticsAttempt(), "updateStep", {
      operation: "record-click",
      stepId: "count",
      exactlyOnce: true,
    }).attempt;

    expect(
      runCheck("idempotent-consumer-writes", { operation: "record-click" }, attempt).status,
    ).toBe("pass");
  });
});
