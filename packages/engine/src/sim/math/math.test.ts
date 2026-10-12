import { describe, expect, it } from "vitest";
import { mixtureQuantile, momentGammaCdf, regularizedGammaP } from "./gamma";
import { harmonic } from "./harmonic";
import { erlangCWait, queueWait, sakasegawaWait } from "./queueing";
import { zipfBuckets } from "./zipf";

describe("harmonic", () => {
  it("matches the exact sum below the switch-over", () => {
    let exact = 0;
    for (let k = 1; k <= 5000; k++) exact += k ** -1.05;
    expect(harmonic(5000, 1.05)).toBeCloseTo(exact, 10);
  });

  it("matches the asymptotic expansion for s = 1", () => {
    const n = 1e9;
    const eulerGamma = 0.5772156649015329;
    expect(harmonic(n, 1)).toBeCloseTo(Math.log(n) + eulerGamma + 1 / (2 * n), 8);
  });

  it("stays continuous across the exact/asymptotic boundary", () => {
    expect(harmonic(10_001, 1.2) - harmonic(10_000, 1.2)).toBeCloseTo(10_001 ** -1.2, 12);
  });
});

describe("zipf buckets", () => {
  const popularity = { s: 1.05, population: 2e10 };

  it("covers every key and all of the traffic", () => {
    const buckets = zipfBuckets(popularity);
    expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(2e10);
    expect(buckets.reduce((m, b) => m + b.mass, 0)).toBeCloseTo(1, 10);
  });

  it("gives the most popular keys a bucket each", () => {
    const [first, second] = zipfBuckets(popularity);
    expect(first?.count).toBe(1);
    expect(second?.count).toBe(1);
  });

  it("reproduces the ideal-cache hit ratios quoted in the problem brief", () => {
    // Fraction of traffic that goes to the 7e7 most popular keys (50 GB of 500 B entries at 70% fill).
    const top = (items: number) => harmonic(items, 1.05) / harmonic(2e10, 1.05);
    expect(top(1.4e7)).toBeCloseTo(0.815, 3);
    expect(top(7e7)).toBeCloseTo(0.862, 3);
    expect(top(2.8e8)).toBeCloseTo(0.9, 3);
  });
});

describe("queueing", () => {
  it("is exact for a single server (M/M/1)", () => {
    for (const rho of [0.3, 0.6, 0.9]) {
      expect(sakasegawaWait(rho, 1, 2)).toBeCloseTo((rho / (1 - rho)) * 2, 10);
      expect(erlangCWait(rho, 1, 2)).toBeCloseTo((rho / (1 - rho)) * 2, 10);
    }
  });

  it("keeps the approximation within 4% of the service time of the exact value", () => {
    for (const servers of [2, 4, 8, 16, 40, 100]) {
      for (const rho of [0.5, 0.7, 0.8, 0.9, 0.95]) {
        const error = Math.abs(sakasegawaWait(rho, servers, 1) - erlangCWait(rho, servers, 1));
        expect(error, `c=${servers} ρ=${rho}`).toBeLessThan(0.04);
      }
    }
  });

  it("matches a published Erlang C value", () => {
    // 10 agents, 8 Erlangs offered: P(wait) ≈ 0.4092, so Wq = P(wait)·S/(c − a).
    expect(erlangCWait(0.8, 10, 1)).toBeCloseTo(0.4092 / 2, 3);
  });

  it("stays finite and stable for thousands of servers", () => {
    const wait = queueWait(0.97, 4000, 1);
    expect(Number.isFinite(wait)).toBe(true);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThan(0.01);
  });

  it("grows without bound as utilisation approaches 1 but stays finite at the cap", () => {
    expect(sakasegawaWait(0.99, 4, 1)).toBe(sakasegawaWait(0.98, 4, 1));
    expect(sakasegawaWait(0.95, 4, 1)).toBeGreaterThan(sakasegawaWait(0.8, 4, 1));
  });
});

describe("gamma and mixtures", () => {
  it("reduces to the exponential distribution for shape 1", () => {
    expect(regularizedGammaP(1, 1)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(regularizedGammaP(1, 5)).toBeCloseTo(1 - Math.exp(-5), 12);
  });

  it("finds the p99 of an exponential latency", () => {
    // mean 2, variance 4 → exponential with rate 1/2; p99 = 2 ln 100
    expect(mixtureQuantile([{ weight: 1, mean: 2, variance: 4 }], 0.99)).toBeCloseTo(
      2 * Math.log(100),
      6,
    );
  });

  it("lets a rare slow path set the p99 of a mixture", () => {
    const fastOnly = mixtureQuantile([{ weight: 1, mean: 2, variance: 0.25 }], 0.99);
    const mixed = mixtureQuantile(
      [
        { weight: 0.95, mean: 2, variance: 0.25 },
        { weight: 0.05, mean: 20, variance: 25 },
      ],
      0.99,
    );
    expect(fastOnly).toBeLessThan(4);
    expect(mixed).toBeGreaterThan(20);
  });

  it("stays accurate for very narrow distributions", () => {
    // shape 1e8: the CDF at mean ± 2 sd should match the normal's 2.3% / 97.7%.
    const narrow = { mean: 100, variance: 1e-4 };
    expect(momentGammaCdf(100 - 0.02, narrow)).toBeCloseTo(0.0228, 3);
    expect(momentGammaCdf(100 + 0.02, narrow)).toBeCloseTo(0.9772, 3);
  });

  it("treats zero variance as a fixed latency", () => {
    expect(momentGammaCdf(2.9, { mean: 3, variance: 0 })).toBe(0);
    expect(momentGammaCdf(3, { mean: 3, variance: 0 })).toBe(1);
  });
});
