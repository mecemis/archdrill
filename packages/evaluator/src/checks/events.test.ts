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
});
