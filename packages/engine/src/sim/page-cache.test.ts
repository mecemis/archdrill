import { describe, expect, it } from "vitest";
import { cacheHitRatio } from "./cache-model";
import { pageCacheHitRatio } from "./page-cache";

const links = { s: 1.05, population: 2e10 };
/** A 64 GiB PostgreSQL copy: 69.2% of it in 16 KiB a key. */
const copyKeys = (64 * 2 ** 30 * 0.692) / 16384;

describe("pageCacheHitRatio", () => {
  it("is the cache model's ratio for reads that come straight", () => {
    const straight = pageCacheHitRatio(links, 1, copyKeys, [{ rate: 1000, missed: [] }]);
    const cache = cacheHitRatio({
      rate: 1000,
      popularity: links,
      capacityItems: copyKeys,
      ttlSec: null,
    });

    expect(straight).toBeCloseTo(cache, 3);
  });

  it("holds more of each shard's keys as shards split them", () => {
    const one = pageCacheHitRatio(links, 1, copyKeys, [{ rate: 1000, missed: [] }]);
    const four = pageCacheHitRatio(links, 4, copyKeys, [{ rate: 1000, missed: [] }]);

    expect(four).toBeGreaterThan(one);
  });

  it("barely hits behind a cache that holds far more keys than it does", () => {
    // Redis: 3 shards × 26.32 GB, 70% filled with 500-byte links, an hour's TTL.
    const redis = { rate: 300_000, popularity: links, capacityItems: 1.1e8, ttlSec: 3600 };
    const missed = [{ input: redis, scale: 1 }];
    const straight = pageCacheHitRatio(links, 2, copyKeys, [{ rate: 50_000, missed: [] }]);
    const behind = pageCacheHitRatio(links, 2, copyKeys, [{ rate: 50_000, missed }]);

    expect(straight).toBeGreaterThan(0.7);
    expect(behind).toBeLessThan(0.05);
  });

  it("mixes reads that come straight with those that missed a cache, by their rates", () => {
    const redis = { rate: 300_000, popularity: links, capacityItems: 1.1e8, ttlSec: 3600 };
    const missed = [{ input: redis, scale: 1 }];
    const at = (straight: number) =>
      pageCacheHitRatio(links, 2, copyKeys, [
        { rate: straight, missed: [] },
        { rate: 50_000, missed },
      ]);

    expect(at(0)).toBeLessThan(at(10_000));
    expect(at(10_000)).toBeLessThan(at(100_000));
  });

  it("holds everything when every key fits", () => {
    expect(
      pageCacheHitRatio({ s: 1.1, population: 5e4 }, 1, copyKeys, [{ rate: 10, missed: [] }]),
    ).toBe(1);
  });
});
