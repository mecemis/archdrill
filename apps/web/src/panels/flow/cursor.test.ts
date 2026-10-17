import { type Attempt, applyCommand, type Flow } from "@archdrill/model";
import { cacheAsideAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { useAttemptStore } from "../../state/store";
import { useUi } from "../../state/ui-store";
import { addAtSlot, cursorPositions, describeCursor, modeOf, nextCursor, slotFor } from "./cursor";

const redirect = (attempt: Attempt) =>
  attempt.flows.find((f) => f.operation === "redirect") as Flow;

/** The redirect flow started afresh: one handler, no steps yet. */
function emptyFlow(): Attempt {
  const base = applyCommand(cacheAsideAttempt(), "removeFlow", { operation: "redirect" }).attempt;
  return applyCommand(base, "createFlow", { operation: "redirect", handler: "api" }).attempt;
}

describe("cursorPositions", () => {
  it("starts an empty flow with its first step", () => {
    expect(cursorPositions(redirect(emptyFlow()), emptyFlow())).toEqual([
      { kind: "append", at: { kind: "root" } },
    ]);
  });

  it("offers a complete flow's place in front of its main path's response", () => {
    const attempt = cacheAsideAttempt();
    const [only, ...rest] = cursorPositions(redirect(attempt), attempt);

    expect(rest).toEqual([]);
    expect(only).toMatchObject({ kind: "insert", at: { kind: "after", stepId: "populate" } });
    expect(only && describeCursor(only, redirect(attempt), attempt, false)).toMatch(
      /^before responding, after \d+ · Redis · /,
    );
  });

  it("puts branches that lead nowhere first", () => {
    const open = applyCommand(cacheAsideAttempt(), "linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "notFound",
      target: null,
    }).attempt;
    const [first] = cursorPositions(redirect(open), open);

    expect(first).toEqual({
      kind: "append",
      at: { kind: "after", stepId: "read", outcomes: ["notFound"] },
    });
    expect(first && describeCursor(first, redirect(open), open, false)).toMatch(
      /^after \d+ · Postgres · .*, if not found$/,
    );
  });
});

describe("nextCursor", () => {
  it("carries on behind the step just added", () => {
    const before = emptyFlow();
    const after = applyCommand(before, "addStep", {
      operation: "redirect",
      id: "get",
      step: { type: "call", target: "redis", action: "cache.get", entity: "Link" },
      attach: { to: "root" },
    }).attempt;

    expect(nextCursor(redirect(before), redirect(after), after)).toMatchObject({
      kind: "append",
      at: { kind: "after", stepId: "get" },
    });
  });
});

describe("slotFor and modeOf", () => {
  it("keep the whole position through a slot", () => {
    const mode = {
      kind: "insert",
      at: { kind: "after", stepId: "a", outcomes: ["ok", "skip"] },
      before: "b",
    } as const;
    const slot = slotFor("redirect", mode, "canvas");

    expect(slot).toMatchObject({
      attach: { to: "outcome", stepId: "a", outcome: "ok" },
      before: "b",
    });
    expect(modeOf(slot)).toEqual(mode);
    expect(modeOf({ operation: "redirect", attach: { to: "root" } })).toEqual({
      kind: "append",
      at: { kind: "root" },
    });
  });
});

describe("addAtSlot", () => {
  it("adds at the slot, then moves the slot behind the new step", () => {
    const start = emptyFlow();
    useAttemptStore.getState().replace(start);
    const slot = slotFor("redirect", { kind: "append", at: { kind: "root" } }, "canvas");

    const added = addAtSlot(slot, {
      type: "call",
      target: "redis",
      action: "cache.get",
      entity: "Link",
    });
    const flow = redirect(useAttemptStore.getState().attempt);
    const next = useUi.getState().slot;

    expect(added).toBe(true);
    expect(flow.root).not.toBeNull();
    expect(next?.source).toBe("canvas");
    expect(next?.mode).toMatchObject({ kind: "append", at: { kind: "after", stepId: flow.root } });
    useUi.getState().armSlot(null);
  });

  it("adds nothing at a place that is gone", () => {
    useAttemptStore.getState().replace(cacheAsideAttempt());
    const gone = slotFor(
      "redirect",
      { kind: "append", at: { kind: "after", stepId: "missing", outcomes: ["ok"] } },
      "canvas",
    );

    expect(addAtSlot(gone, { type: "logic", logic: "checkExpiry" })).toBe(false);
  });

  it("carries on in front of the response after a step inserted there", () => {
    const before = cacheAsideAttempt();
    const [place] = cursorPositions(redirect(before), before);
    if (!place) throw new Error("no place");
    useAttemptStore.getState().replace(before);

    addAtSlot(slotFor("redirect", place, "canvas"), {
      type: "call",
      target: "db",
      action: "store.read",
      entity: "Link",
    });

    expect(useUi.getState().slot?.mode).toMatchObject({ kind: "insert" });
    expect(useUi.getState().slot?.mode).not.toEqual(place);
    useUi.getState().armSlot(null);
  });
});
