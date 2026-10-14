import type { Flow } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import type { Slot } from "../../state/ui-store";
import { pathTo, type SuggestionInput, suggestNext } from "./suggestions";

const attempt = cacheAsideAttempt();
const flow = attempt.flows[0] as Flow;
const redirect = testProblem.operations.find((o) => o.id === "redirect");
if (!redirect) throw new Error("the test problem has no redirect");

function suggestions(slot: Slot, overrides: Partial<SuggestionInput> = {}) {
  return suggestNext({
    attempt,
    flow,
    slot,
    problem: testProblem,
    operation: redirect as NonNullable<typeof redirect>,
    catalog: testCatalogIndex,
    background: false,
    defaultEntity: "Link",
    ...overrides,
  }).map((s) => s.key);
}

const afterOutcome = (stepId: string, outcome: string): Slot => ({
  operation: "redirect",
  attach: { to: "outcome", stepId, outcome },
});

describe("suggestNext", () => {
  it("offers the store after a cache miss, before any response", () => {
    expect(suggestions(afterOutcome("get", "miss"))[0]).toBe("call:db:store.read");
  });

  it("leads with the usual response when an outcome ends the request", () => {
    expect(suggestions(afterOutcome("read", "error"))[0]).toBe("respond:503");
    expect(suggestions(afterOutcome("read", "notFound"))[0]).toBe("respond:404");
  });

  it("fills the cache after the store answered", () => {
    expect(suggestions(afterOutcome("read", "found"))).toContain("call:redis:cache.set");
  });

  it("ends a successful branch with the operation's success status", () => {
    expect(suggestions(afterOutcome("expiryHit", "valid"))).toContain("respond:302");
  });

  it("starts a read by asking the cache", () => {
    const empty: Flow = { ...flow, root: null, steps: {} };
    const first = suggestions({ operation: "redirect", attach: { to: "root" } }, { flow: empty });

    expect(first[0]).toBe("call:redis:cache.get");
  });

  it("suggests only decisions that some request of the operation can trigger", () => {
    const keys = suggestions(afterOutcome("read", "found"), { facts: new Set(["expired"]) });

    expect(keys).toContain("logic:checkExpiry");
    expect(keys).not.toContain("logic:validateUrl");
  });

  it("lets background work only finish or ask to be retried", () => {
    const keys = suggestions(afterOutcome("read", "error"), { background: true });

    expect(keys[0]).toBe("respond:503");
    expect(keys).not.toContain("respond:404");
  });
});

describe("pathTo", () => {
  it("follows the first branch that reaches a step", () => {
    expect(pathTo(flow, "populate").map((s) => (s.type === "call" ? s.action : s.type))).toEqual([
      "cache.get",
      "store.read",
      "logic",
      "cache.set",
    ]);
  });
});
