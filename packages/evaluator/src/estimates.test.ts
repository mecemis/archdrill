import { EstimateSchema } from "@archdrill/model";
import { cacheAsideAttempt, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { evaluateEstimates, judgeEstimate } from "./estimates";

const linksPerDay = EstimateSchema.parse({
  id: "links-per-day",
  question: "How many links are created a day?",
  kind: "count",
  answer: 86.4e6,
  derivation: "1,000 a second × 86,400 seconds.",
});

describe("judgeEstimate", () => {
  it("calls an estimate within 25% spot on, either way", () => {
    expect(judgeEstimate(linksPerDay, 100e6).band).toBe("spot-on");
    expect(judgeEstimate(linksPerDay, 70e6).band).toBe("spot-on");
  });

  it("calls one within the tolerance close, and the rest off", () => {
    expect(judgeEstimate(linksPerDay, 150e6)).toMatchObject({ band: "close" });
    expect(judgeEstimate(linksPerDay, 50e6)).toMatchObject({ band: "close" });
    expect(judgeEstimate(linksPerDay, 1e9)).toMatchObject({ band: "off" });
    expect(judgeEstimate(linksPerDay, 1e9).ratio).toBeCloseTo(11.57, 2);
  });
});

describe("evaluateEstimates", () => {
  it("lists every estimate, answered or not", () => {
    const problem = { ...testProblem, estimates: [linksPerDay] };
    const attempt = { ...cacheAsideAttempt(), estimates: { "links-per-day": 86e6 } };

    expect(evaluateEstimates(attempt, problem)).toEqual([
      expect.objectContaining({ value: 86e6, band: "spot-on" }),
    ]);
    expect(evaluateEstimates(cacheAsideAttempt(), problem)).toEqual([
      expect.objectContaining({ value: null, band: null }),
    ]);
  });
});
