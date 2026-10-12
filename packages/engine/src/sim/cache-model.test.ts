import { describe, expect, it } from "vitest";
import { cacheHitRatio } from "./cache-model";
import { harmonic } from "./math/harmonic";

const links = { s: 1.05, population: 2e10 };
const base = { rate: 300_000, popularity: links, capacityItems: 7e7, ttlSec: null };

describe("cacheHitRatio", () => {
  it("serves everything from a cache that holds every key and never expires", () => {
    const small = { s: 1.05, population: 1000 };
    expect(cacheHitRatio({ ...base, popularity: small, capacityItems: 5000 })).toBeGreaterThan(
      0.999,
    );
  });

  it("stays below the ideal top-C cache but close to it for skewed traffic", () => {
    const ideal = harmonic(7e7, 1.05) / harmonic(2e10, 1.05);
    const lru = cacheHitRatio(base);
    expect(lru).toBeLessThan(ideal);
    expect(lru).toBeGreaterThan(ideal - 0.06);
  });

  it("rises with memory and falls with shorter TTLs", () => {
    const at = (capacityItems: number, ttlSec: number | null) =>
      cacheHitRatio({ ...base, capacityItems, ttlSec });
    expect(at(1.4e7, null)).toBeLessThan(at(7e7, null));
    expect(at(7e7, null)).toBeLessThan(at(2.8e8, null));
    expect(at(7e7, 60)).toBeLessThan(at(7e7, 3600));
    expect(at(7e7, 3600)).toBeLessThanOrEqual(at(7e7, null));
  });

  it("gives the same answer whatever order nearby inputs are asked in", () => {
    const a = { ...base, rate: 123_456.1 };
    const b = { ...base, rate: 123_456.4 };
    const forward = [cacheHitRatio(a), cacheHitRatio(b)];
    const backward = [
      cacheHitRatio({ ...b, ttlSec: 1234 }),
      cacheHitRatio({ ...a, ttlSec: 1234 }),
    ].reverse();
    expect(forward[0]).toBe(forward[1]);
    expect(backward[0]).toBe(backward[1]);
  });

  it("is zero without traffic or memory", () => {
    expect(cacheHitRatio({ ...base, rate: 0 })).toBe(0);
    expect(cacheHitRatio({ ...base, capacityItems: 0 })).toBe(0);
  });

  it("matches the renewal formula when only the TTL limits", () => {
    // One key, 10 requests/s, TTL 1s: each cycle is one miss and ~10 hits.
    const single = { s: 1, population: 1 };
    expect(
      cacheHitRatio({ rate: 10, popularity: single, capacityItems: 10, ttlSec: 1 }),
    ).toBeCloseTo(10 / 11, 10);
  });
});
