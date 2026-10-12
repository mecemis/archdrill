import { applyPatches } from "immer";
import { describe, expect, it } from "vitest";
import { emptyAttempt } from "../attempt/schema";
import { cacheAsideAttempt } from "../testing/fixtures";
import { applyCommand, CommandError } from "./index";

describe("commands", () => {
  it("adds components with generated ids and layout positions", () => {
    const first = applyCommand(emptyAttempt("p", 1), "addComponent", {
      kind: "cache",
      flavor: "redis",
      label: "Redis",
      position: { x: 10, y: 20 },
    });
    const second = applyCommand(first.attempt, "addComponent", {
      kind: "cache",
      flavor: "redis",
      label: "Redis 2",
      position: { x: 0, y: 0 },
    });

    expect(first.result).toBe("cache-1");
    expect(second.result).toBe("cache-2");
    expect(second.attempt.layout["cache-1"]).toEqual({ x: 10, y: 20 });
    expect(second.attempt.architecture.components[0]).toEqual({
      id: "cache-1",
      kind: "cache",
      flavor: "redis",
      label: "Redis",
      replicas: 1,
      shards: 1,
      data: [],
    });
  });

  it("never mutates the input attempt", () => {
    const original = cacheAsideAttempt();
    const snapshot = cacheAsideAttempt();

    applyCommand(original, "removeComponent", { id: "redis" });

    expect(original).toEqual(snapshot);
  });

  it("undoes any command by applying its inverse patches", () => {
    const original = cacheAsideAttempt();
    const { attempt, inversePatches } = applyCommand(original, "removeComponent", { id: "redis" });

    expect(applyPatches(attempt, inversePatches)).toEqual(original);
  });

  it("removing a component removes its connections and the steps that call it", () => {
    const { attempt } = applyCommand(cacheAsideAttempt(), "removeComponent", { id: "redis" });
    const flow = attempt.flows[0];

    expect(attempt.architecture.connections.map((c) => c.id)).not.toContain("api--redis");
    expect(flow?.steps.get).toBeUndefined();
    expect(flow?.steps.populate).toBeUndefined();
    expect(flow?.root).toBeNull();
    expect(flow?.steps.expiryDb).toEqual({
      type: "logic",
      logic: "checkExpiry",
      next: { expired: "r410" },
    });
  });

  it("removing the handler removes its flows", () => {
    const { attempt } = applyCommand(cacheAsideAttempt(), "removeComponent", { id: "api" });

    expect(attempt.flows).toEqual([]);
  });

  it("rejects duplicate connections and self-loops", () => {
    const attempt = cacheAsideAttempt();

    expect(() => applyCommand(attempt, "addConnection", { from: "lb", to: "api" })).toThrow(
      CommandError,
    );
    expect(() => applyCommand(attempt, "addConnection", { from: "api", to: "api" })).toThrow(
      CommandError,
    );
  });

  it("reverses a connection and renames it after its new direction", () => {
    const { attempt } = applyCommand(cacheAsideAttempt(), "reverseConnection", { id: "lb--api" });

    expect(attempt.architecture.connections).toContainEqual({
      id: "api--lb",
      from: "api",
      to: "lb",
      mode: "sync",
    });
  });

  it("inserts a step in front of the first step with continueWith", () => {
    const base = cacheAsideAttempt();
    const withoutCache = applyCommand(base, "removeStep", {
      operation: "redirect",
      stepId: "get",
      bypass: "miss",
    }).attempt;

    const { attempt, result } = applyCommand(withoutCache, "addStep", {
      operation: "redirect",
      step: { type: "call", target: "redis", action: "cache.get", entity: "Link" },
      attach: { to: "root" },
      continueWith: { outcome: "miss" },
    });

    const flow = attempt.flows[0];
    expect(flow?.root).toBe(result);
    expect(flow?.steps[result]).toMatchObject({ action: "cache.get", next: { miss: "read" } });
  });

  it("refuses to replace the first step without continueWith", () => {
    expect(() =>
      applyCommand(cacheAsideAttempt(), "addStep", {
        operation: "redirect",
        step: { type: "respond", status: 302 },
        attach: { to: "root" },
      }),
    ).toThrow(/already has a first step/);
  });

  it("attaches a new step behind an outcome", () => {
    const unlinked = applyCommand(cacheAsideAttempt(), "linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "notFound",
      target: null,
    }).attempt;

    const { attempt, result } = applyCommand(unlinked, "addStep", {
      operation: "redirect",
      step: {
        type: "call",
        target: "redis",
        action: "cache.setNegative",
        entity: "Link",
        ttlSec: 60,
      },
      attach: { to: "outcome", stepId: "read", outcome: "notFound" },
    });

    expect(result).toBe("s1");
    expect(attempt.flows[0]?.steps.read).toMatchObject({ next: { notFound: "s1" } });
  });

  it("removing a step re-points references through the bypass outcome", () => {
    const { attempt } = applyCommand(cacheAsideAttempt(), "removeStep", {
      operation: "redirect",
      stepId: "populate",
      bypass: "ok",
    });

    expect(attempt.flows[0]?.steps.expiryDb).toMatchObject({ next: { valid: "r302" } });
  });

  it("prunes the steps a removal leaves unreachable when asked to", () => {
    const { attempt } = applyCommand(cacheAsideAttempt(), "removeStep", {
      operation: "redirect",
      stepId: "read",
      prune: true,
    });

    expect(Object.keys(attempt.flows[0]?.steps ?? {}).sort()).toEqual([
      "expiryHit",
      "get",
      "r302",
      "r410",
    ]);
  });

  it("refuses to overwrite an outcome that already leads somewhere", () => {
    expect(() =>
      applyCommand(cacheAsideAttempt(), "addStep", {
        operation: "redirect",
        step: { type: "respond", status: 500 },
        attach: { to: "outcome", stepId: "read", outcome: "error" },
      }),
    ).toThrow(/already leads somewhere/);
  });

  it("prunes only what the removal cut off, not steps parked earlier", () => {
    const parked = applyCommand(cacheAsideAttempt(), "addStep", {
      operation: "redirect",
      id: "parked",
      step: { type: "logic", logic: "validateUrl" },
      attach: { to: "root" },
      continueWith: { outcome: "valid" },
    }).attempt;
    const detached = applyCommand(parked, "setRoot", {
      operation: "redirect",
      stepId: "get",
    }).attempt;

    const { attempt } = applyCommand(detached, "removeStep", {
      operation: "redirect",
      stepId: "read",
      prune: true,
    });

    expect(Object.keys(attempt.flows[0]?.steps ?? {})).toContain("parked");
    expect(attempt.flows[0]?.steps.expiryDb).toBeUndefined();
  });

  it("refuses to reverse a connection onto an id that is taken", () => {
    const taken = applyCommand(cacheAsideAttempt(), "addConnection", {
      id: "api--lb",
      from: "db",
      to: "redis",
    }).attempt;

    expect(() => applyCommand(taken, "reverseConnection", { id: "lb--api" })).toThrow(
      /already exists/,
    );
  });

  it("rejects links to outcomes a step does not have", () => {
    expect(() =>
      applyCommand(cacheAsideAttempt(), "linkOutcome", {
        operation: "redirect",
        stepId: "read",
        outcome: "hit",
        target: "r302",
      }),
    ).toThrow(CommandError);
  });

  it("validates command arguments", () => {
    expect(() =>
      applyCommand(cacheAsideAttempt(), "updateComponent", { id: "api", replicas: 0 }),
    ).toThrow();
  });

  it("keeps counts within the calibrated bounds", () => {
    expect(() =>
      applyCommand(cacheAsideAttempt(), "updateComponent", { id: "api", replicas: 5000 }),
    ).toThrow();
    expect(() =>
      applyCommand(cacheAsideAttempt(), "updateComponent", { id: "db", shards: 5000 }),
    ).toThrow();
  });

  it("sets and clears decisions", () => {
    const set = applyCommand(cacheAsideAttempt(), "setDecision", {
      decision: "redirect-status",
      option: "s302",
    });
    const cleared = applyCommand(set.attempt, "setDecision", {
      decision: "redirect-status",
      option: null,
    });

    expect(set.attempt.decisions).toEqual({ "redirect-status": "s302" });
    expect(cleared.attempt.decisions).toEqual({});
  });
});
