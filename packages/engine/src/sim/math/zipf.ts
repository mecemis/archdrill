import { harmonic } from "./harmonic";

/** A run of consecutive popularity ranks treated as one group. */
export interface RankBucket {
  /** Number of keys in the bucket. */
  readonly count: number;
  /** Share of all requests that go to keys in this bucket. */
  readonly mass: number;
}

export interface ZipfPopularity {
  /** Skew: larger s concentrates traffic on fewer keys. */
  readonly s: number;
  /** Number of distinct keys. */
  readonly population: number;
}

export const DEFAULT_BUCKETS = 256;

const bucketCache = new Map<string, readonly RankBucket[]>();

/**
 * Groups ranks 1..N into log-spaced buckets so models can integrate over
 * billions of keys cheaply. The head (most popular keys) gets one bucket per
 * rank, so the part that matters most for caching stays exact.
 */
export function zipfBuckets(
  { s, population }: ZipfPopularity,
  buckets = DEFAULT_BUCKETS,
): readonly RankBucket[] {
  const key = `${s}|${population}|${buckets}`;
  const cached = bucketCache.get(key);
  if (cached) return cached;
  const n = Math.max(1, Math.floor(population));
  const total = harmonic(n, s);
  const result: RankBucket[] = [];
  let low = 1;
  for (let i = 1; i <= buckets && low <= n; i++) {
    const high = Math.min(n, Math.max(low, Math.round(n ** (i / buckets))));
    const mass = (harmonic(high, s) - harmonic(low - 1, s)) / total;
    result.push({ count: high - low + 1, mass });
    low = high + 1;
  }
  bucketCache.set(key, result);
  return result;
}
