import { type Attempt, applyCommand } from "@archdrill/model";
import { cacheAsideAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { slotStillValid } from "./slot";
import type { Slot } from "./ui-store";

/** The redirect flow with its not-found outcome leading nowhere yet. */
function withOpenOutcome(): Attempt {
  return applyCommand(cacheAsideAttempt(), "linkOutcome", {
    operation: "redirect",
    stepId: "read",
    outcome: "notFound",
    target: null,
  }).attempt;
}

const open: Slot = {
  operation: "redirect",
  attach: { to: "outcome", stepId: "read", outcome: "notFound" },
};
/** In front of the 404 the not-found outcome leads to. */
const beforeNotFound: Slot = { ...open, before: "r404" };

describe("slotStillValid", () => {
  it("keeps an open outcome's slot until something fills it", () => {
    expect(slotStillValid(open, withOpenOutcome())).toBe(true);
    expect(slotStillValid(open, cacheAsideAttempt())).toBe(false);
  });

  it("keeps a slot in front of a step only while the outcome still leads to it", () => {
    expect(slotStillValid(beforeNotFound, cacheAsideAttempt())).toBe(true);
    // The outcome now leads elsewhere, as it does once a step was added there.
    const moved = applyCommand(cacheAsideAttempt(), "linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "notFound",
      target: "r503",
    }).attempt;
    expect(slotStillValid(beforeNotFound, moved)).toBe(false);
  });

  it("drops a slot whose step is gone, or whose flow is", () => {
    const removed = applyCommand(cacheAsideAttempt(), "removeStep", {
      operation: "redirect",
      stepId: "read",
    }).attempt;
    const noFlow = applyCommand(cacheAsideAttempt(), "removeFlow", {
      operation: "redirect",
    }).attempt;

    expect(slotStillValid(beforeNotFound, removed)).toBe(false);
    expect(slotStillValid(open, noFlow)).toBe(false);
  });
});
