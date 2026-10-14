import { applyCommand } from "@archdrill/model";
import { asyncAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { runCheck } from "../test-support";

const params = { operation: "create-link", event: "link-created" };

describe("no-dual-write", () => {
  it("fails a publish after the write has committed", () => {
    const outcome = runCheck("no-dual-write", params, asyncAttempt());

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(/after the write has committed/);
    expect(outcome.evidence).toContainEqual({
      type: "step",
      operation: "create-link",
      stepId: "publish",
    });
  });

  it("passes a publish through a transactional outbox", () => {
    const attempt = applyCommand(asyncAttempt(), "updateStep", {
      operation: "create-link",
      stepId: "publish",
      outbox: true,
    }).attempt;

    expect(runCheck("no-dual-write", params, attempt).status).toBe("pass");
  });

  it("fails a plain publish that follows an outbox publish of the same event", () => {
    let attempt = applyCommand(asyncAttempt(), "updateStep", {
      operation: "create-link",
      stepId: "publish",
      outbox: true,
    }).attempt;
    attempt = applyCommand(attempt, "addStep", {
      operation: "create-link",
      id: "again",
      step: { type: "call", target: "queue", action: "queue.publish", event: "link-created" },
      attach: { to: "outcome", stepId: "publish", outcome: "ok" },
      continueWith: { outcome: "ok" },
    }).attempt;

    const outcome = runCheck("no-dual-write", params, attempt);

    expect(outcome.status).toBe("fail");
    expect(outcome.evidence).toContainEqual({
      type: "step",
      operation: "create-link",
      stepId: "again",
    });
  });

  it("does not apply when no publishing path writes the entity named", () => {
    const outcome = runCheck("no-dual-write", { ...params, entity: "LinkStats" }, asyncAttempt());

    expect(outcome.status).toBe("n/a");
  });
});
