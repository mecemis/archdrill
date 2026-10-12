import { cacheAsideAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluation";

describe("evaluate", () => {
  it("evaluates each attempt version once and shares the result", () => {
    const attempt = cacheAsideAttempt();

    expect(evaluate(attempt)).toBe(evaluate(attempt));
    expect(evaluate(cacheAsideAttempt())).not.toBe(evaluate(attempt));
  });
});
