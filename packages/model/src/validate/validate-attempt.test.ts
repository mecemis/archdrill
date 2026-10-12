import { describe, expect, it } from "vitest";
import type { Attempt } from "../attempt/schema";
import { applyCommand, type CommandArgs, type CommandName } from "../commands/index";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "../testing/fixtures";
import type { IssueCode } from "./issues";
import { validateAttempt } from "./validate-attempt";

const ctx = { catalog: testCatalogIndex, problem: testProblem };

function codes(attempt: Attempt): IssueCode[] {
  return validateAttempt(attempt, ctx).map((issue) => issue.code);
}

function mutate<N extends CommandName>(
  name: N,
  args: CommandArgs<N>,
  base = cacheAsideAttempt(),
): Attempt {
  return applyCommand(base, name, args).attempt;
}

describe("validateAttempt", () => {
  it("accepts the complete cache-aside fixture without issues", () => {
    expect(validateAttempt(cacheAsideAttempt(), ctx)).toEqual([]);
  });

  it("reports an unreachable handler when the ingress connection is reversed", () => {
    const attempt = mutate("reverseConnection", { id: "lb--api" });

    expect(codes(attempt)).toContain("flow-handler-unreachable");
  });

  it("reports a call without a connection when the dependency edge is reversed", () => {
    const attempt = mutate("reverseConnection", { id: "api--redis" });

    const issues = validateAttempt(attempt, ctx).filter((i) => i.code === "step-no-connection");
    expect(issues.map((i) => i.location)).toEqual([
      { type: "step", operation: "redirect", stepId: "get" },
      { type: "step", operation: "redirect", stepId: "populate" },
    ]);
  });

  it("warns about unhandled outcomes with the exact step and outcome", () => {
    const attempt = mutate("linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "notFound",
      target: null,
    });

    const issue = validateAttempt(attempt, ctx).find((i) => i.code === "step-unhandled-outcome");
    expect(issue?.severity).toBe("warning");
    expect(issue?.location).toEqual({
      type: "step",
      operation: "redirect",
      stepId: "read",
      outcome: "notFound",
    });
  });

  it("asks for a negative-hit branch only once the design stores negative entries", () => {
    const withNegative = mutate("addStep", {
      operation: "redirect",
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

    const unhandled = (attempt: Attempt) =>
      validateAttempt(attempt, ctx)
        .filter((i) => i.code === "step-unhandled-outcome")
        .map((i) => i.location);

    expect(unhandled(cacheAsideAttempt())).toEqual([]);
    expect(unhandled(withNegative)).toContainEqual({
      type: "step",
      operation: "redirect",
      stepId: "get",
      outcome: "negativeHit",
    });
  });

  it("does not let an unreachable negative-cache step enable negative hits", () => {
    const orphan = mutate("addStep", {
      operation: "redirect",
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
    const detached = mutate(
      "linkOutcome",
      { operation: "redirect", stepId: "read", outcome: "notFound", target: "r404" },
      orphan,
    );

    const codes = validateAttempt(detached, ctx).map(
      (i) => `${i.code}:${"outcome" in i.location ? i.location.outcome : ""}`,
    );

    expect(codes).toContain("step-unreachable:");
    expect(codes).not.toContain("step-unhandled-outcome:negativeHit");
  });

  it("does not let negative caching behind the negative-hit branch justify itself", () => {
    const linked = mutate("linkOutcome", {
      operation: "redirect",
      stepId: "get",
      outcome: "negativeHit",
      target: "r404",
    });
    const selfJustifying = mutate(
      "addStep",
      {
        operation: "redirect",
        id: "neg",
        step: {
          type: "call",
          target: "redis",
          action: "cache.setNegative",
          entity: "Link",
          ttlSec: 60,
        },
        attach: { to: "root" },
        continueWith: { outcome: "ok" },
      },
      mutate(
        "linkOutcome",
        { operation: "redirect", stepId: "get", outcome: "negativeHit", target: null },
        linked,
      ),
    );
    // Now: neg (root) → get; but move neg behind get's negativeHit so it can only run after a negative hit.
    const hidden = mutate(
      "setRoot",
      { operation: "redirect", stepId: "get" },
      mutate(
        "linkOutcome",
        { operation: "redirect", stepId: "get", outcome: "negativeHit", target: "neg" },
        selfJustifying,
      ),
    );

    const issues = validateAttempt(hidden, ctx).map(
      (i) => `${i.code}:${"stepId" in i.location ? i.location.stepId : ""}`,
    );

    expect(issues).toContain("step-infeasible-outcome:get");
    expect(issues).toContain("step-unreachable:neg");
  });

  it("rejects durable-store actions on a store that does not hold the entity", () => {
    const attempt = mutate("setComponentData", { id: "db", entities: [] });

    expect(codes(attempt)).toContain("step-entity-not-stored");
  });

  it("rejects actions the target cannot perform", () => {
    const base = cacheAsideAttempt();
    const flow = base.flows[0];
    const step = flow?.steps.read;
    if (!flow || step?.type !== "call") throw new Error("fixture changed");
    const attempt: Attempt = {
      ...base,
      flows: [{ ...flow, steps: { ...flow.steps, read: { ...step, target: "redis" } } }],
    };

    expect(codes(attempt)).toContain("step-action-not-supported");
  });

  it("requires ttlSec on cache.set", () => {
    const attempt = mutate("updateStep", {
      operation: "redirect",
      stepId: "populate",
      ttlSec: null,
    });

    expect(codes(attempt)).toContain("step-missing-param");
  });

  it("detects loops between steps", () => {
    const attempt = mutate("linkOutcome", {
      operation: "redirect",
      stepId: "populate",
      outcome: "error",
      target: "get",
    });

    expect(codes(attempt)).toContain("flow-cycle");
  });

  it("flags steps that are not reachable from the first step", () => {
    const attempt = mutate("linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "error",
      target: null,
    });
    const orphanAttempt = mutate(
      "linkOutcome",
      { operation: "redirect", stepId: "read", outcome: "notFound", target: "r503" },
      attempt,
    );

    expect(codes(orphanAttempt)).toContain("step-unreachable");
  });

  it("rejects a handler that is not a service", () => {
    const attempt = mutate("setFlowHandler", { operation: "redirect", handler: "db" });

    expect(codes(attempt)).toContain("flow-handler-not-compute");
  });

  it("rejects duplicate connections and self-loops", () => {
    const base = cacheAsideAttempt();
    const attempt: Attempt = {
      ...base,
      architecture: {
        ...base.architecture,
        connections: [
          ...base.architecture.connections,
          { id: "dup", from: "lb", to: "api", mode: "sync" },
          { id: "loop", from: "api", to: "api", mode: "sync" },
        ],
      },
    };

    expect(codes(attempt)).toEqual(
      expect.arrayContaining(["connection-duplicate", "connection-self-loop"]),
    );
  });

  it("rejects unknown flavors, sizes and replicas on non-replicable kinds", () => {
    const attempt = mutate("updateComponent", { id: "lb", replicas: 2 });
    const unknownSize = mutate("updateComponent", { id: "api", size: "xxl" });

    expect(codes(attempt)).toContain("replicas-not-supported");
    expect(codes(unknownSize)).toContain("unknown-size");
  });

  it("warns that replicas are ignored on managed components", () => {
    const base = cacheAsideAttempt();
    const components = base.architecture.components.map((c) =>
      c.id === "lb" ? { ...c, replicas: 3 } : c,
    );
    const managed: Attempt = { ...base, architecture: { ...base.architecture, components } };

    const issue = validateAttempt(managed, ctx).find((i) => i.code === "replicas-ignored");

    expect(issue?.severity).toBe("warning");
  });

  it("rejects decisions that the problem does not define", () => {
    const attempt = mutate("setDecision", { decision: "redirect-status", option: "s307" });

    expect(codes(attempt)).toContain("decision-unknown-option");
  });
});
