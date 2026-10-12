import { applyCommand } from "@archdrill/model";
import { cacheAsideAttempt, createLinkAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { runCheck } from "../test-support";

const GENERATED_201 = {
  all: [{ status: [201] }, { hasStep: { logic: "hasCustomAlias", outcome: "generated" } }],
};

const strategies = {
  operation: "create-link",
  scope: GENERATED_201,
  decision: "redirect-status",
  strategies: [
    {
      id: "kgs",
      label: "Key generation service",
      where: { hasStep: { action: "ids.allocate", outcome: "ok" } },
      note: "Keys are unique by construction.",
    },
    {
      id: "random-conditional",
      label: "Random code with conditional insert",
      where: {
        all: [
          { hasStep: { logic: "generateRandomCode" } },
          { hasStep: { action: "store.insertIfAbsent", outcome: "ok" } },
        ],
      },
      note: "Collisions are retried.",
    },
  ],
};

describe("recognize-strategy", () => {
  it("names the approach each design implements", () => {
    const kgs = runCheck("recognize-strategy", strategies, createLinkAttempt("kgs"));
    const random = runCheck("recognize-strategy", strategies, createLinkAttempt("random-retry"));

    expect(kgs).toMatchObject({ status: "pass", data: { strategy: "kgs" } });
    expect(kgs.message).toBe(
      "Recognised: Key generation service. Keys are unique by construction.",
    );
    expect(random.data?.strategy).toBe("random-conditional");
  });

  it("flags a declared decision that the flow contradicts", () => {
    const attempt = applyCommand(createLinkAttempt("kgs"), "setDecision", {
      decision: "redirect-status",
      option: "s302",
    }).attempt;

    const outcome = runCheck("recognize-strategy", strategies, attempt);

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toBe(
      'You chose "302", but the flow implements key generation service.',
    );
  });

  it("gives partial credit to an approach it does not recognise", () => {
    const outcome = runCheck(
      "recognize-strategy",
      { ...strategies, strategies: [strategies.strategies[0]] },
      createLinkAttempt("random"),
    );

    expect(outcome).toMatchObject({
      status: "partial",
      fraction: 0.5,
      data: { strategy: "unrecognised" },
    });
  });

  it("is not applicable before any path is in scope", () => {
    expect(runCheck("recognize-strategy", strategies, cacheAsideAttempt()).status).toBe("n/a");
  });
});

describe("hasStepTimes", () => {
  const noRetry = {
    operation: "create-link",
    where: {
      all: [
        { hasStep: { logic: "hasCustomAlias", outcome: "generated" } },
        { hasStep: { action: "store.insertIfAbsent", outcome: "conflict" } },
        { not: { hasStepTimes: { step: { action: "store.insertIfAbsent" }, min: 2 } } },
      ],
    },
  };

  it("finds generated collisions that are never retried", () => {
    expect(runCheck("no-path", noRetry, createLinkAttempt("random")).status).toBe("fail");
    expect(runCheck("no-path", noRetry, createLinkAttempt("random-retry")).status).toBe("pass");
  });
});

describe("ingress-has-capability", () => {
  const params = { operation: "create-link", capability: "rate-limiting" };

  it("fails when nothing on the way in limits requests", () => {
    expect(runCheck("ingress-has-capability", params, createLinkAttempt("kgs")).status).toBe(
      "fail",
    );
  });

  it("passes when a gateway sits on the ingress route", () => {
    let attempt = applyCommand(createLinkAttempt("kgs"), "addComponent", {
      id: "gw",
      kind: "api-gateway",
      flavor: "managed",
      label: "Gateway",
      position: { x: 0, y: 0 },
    }).attempt;
    attempt = applyCommand(attempt, "removeConnection", { id: "lb--api" }).attempt;
    attempt = applyCommand(attempt, "addConnection", { from: "lb", to: "gw" }).attempt;
    attempt = applyCommand(attempt, "addConnection", { from: "gw", to: "api" }).attempt;

    expect(runCheck("ingress-has-capability", params, attempt).message).toBe(
      "Gateway provides rate-limiting on the way in.",
    );
  });
});
