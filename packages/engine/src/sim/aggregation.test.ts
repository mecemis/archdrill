import { describe, expect, it } from "vitest";
import { hotWindowShare, windowWriteShare } from "./aggregation";

const links = { s: 1.05, population: 2e10 };

describe("windowWriteShare", () => {
  it("writes once per item when the window holds one item or less", () => {
    expect(windowWriteShare(0.5, 1, links)).toBe(1);
    expect(windowWriteShare(1000, 10, undefined)).toBe(1);
  });

  it("collapses repeated keys, more so over longer windows", () => {
    const short = windowWriteShare(300_000, 1, links);
    const long = windowWriteShare(300_000, 60, links);

    expect(short).toBeLessThan(1);
    expect(long).toBeLessThan(short);
  });

  it("matches a direct count over a small population", () => {
    // Four keys with masses 1/H, 1/2H, 1/3H, 1/4H for s = 1, 100 items.
    const h = 1 + 1 / 2 + 1 / 3 + 1 / 4;
    const expected = [1, 2, 3, 4].reduce((sum, k) => sum + -Math.expm1(-100 / (k * h)), 0) / 100;

    expect(windowWriteShare(100, 1, { s: 1, population: 4 })).toBeCloseTo(expected, 6);
  });
});

describe("hotWindowShare", () => {
  it("writes a hot key once per window", () => {
    expect(hotWindowShare(1_000_000, 10)).toBeCloseTo(1e-7);
    expect(hotWindowShare(0.05, 10)).toBe(1);
  });
});
