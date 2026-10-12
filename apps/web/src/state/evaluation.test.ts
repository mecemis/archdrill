import { applyCommand } from "@archdrill/model";
import { cacheAsideAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluation";

describe("evaluate", () => {
  it("evaluates each attempt version once and shares the result", () => {
    const attempt = cacheAsideAttempt();

    expect(evaluate(attempt)).toBe(evaluate(attempt));
    expect(evaluate(cacheAsideAttempt())).not.toBe(evaluate(attempt));
  });

  it("does not re-evaluate when only the layout changes", () => {
    const attempt = cacheAsideAttempt();
    const moved = applyCommand(attempt, "moveComponent", {
      id: "api",
      position: { x: 999, y: 999 },
    }).attempt;

    expect(evaluate(moved)).toBe(evaluate(attempt));
  });
});
