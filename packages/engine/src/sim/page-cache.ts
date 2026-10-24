import { type CacheModelInput, cacheHitsByBucket } from "./cache-model";
import { type ZipfPopularity, zipfBuckets } from "./math/zipf";

/** A cache in front of the store: its model's inputs, and what scales its hits to the fixed point's. */
export interface MissedCache {
  readonly input: CacheModelInput;
  readonly scale: number;
}

/** Reads of one entity that reach a store the same way. */
export interface ReadStream {
  /** Reads a second. */
  readonly rate: number;
  /** The caches these reads missed on the way. */
  readonly missed: readonly MissedCache[];
}

const BISECTION_STEPS = 40;
const MIN_LOG_TIME = Math.log(1e-12);
const MAX_LOG_TIME = Math.log(1e18);
const MEMO_LIMIT = 4096;
const memo = new Map<string, number>();

/** Four significant digits: iterations ask for nearly the same inputs again and again. */
const rounded = (x: number) => Number(x.toPrecision(4));

/**
 * Share of a store's reads of one entity that its page cache answers, an
 * LRU over the keys of one shard (Che's approximation, as for caches). Reads
 * that come straight follow the keys' popularity; reads that missed a cache
 * in front are the keys that cache does not hold, so they lean towards the
 * tail, which a page cache much smaller than that cache barely holds.
 * Replicas share a shard's reads, which scales every key's rate alike and
 * leaves the hit ratio as it is. Inputs are rounded to four significant
 * digits and the model runs on the rounded values, so the result depends
 * only on them, whichever iteration asks first.
 */
export function pageCacheHitRatio(
  popularity: ZipfPopularity,
  shards: number,
  /** Keys one copy's page cache holds. */
  capacityKeys: number,
  streams: readonly ReadStream[],
): number {
  const capacity = rounded(capacityKeys);
  const ways = streams
    .filter((s) => s.rate > 0)
    .map((s) => ({
      rate: rounded(s.rate),
      missed: s.missed.map((m) => ({
        input: {
          ...m.input,
          rate: rounded(m.input.rate),
          capacityItems: rounded(m.input.capacityItems),
        },
        scale: rounded(m.scale),
      })),
    }));
  const key = JSON.stringify([popularity.s, popularity.population, shards, capacity, ways]);
  const known = memo.get(key);
  if (known !== undefined) return known;
  const hit = cheHitRatio(popularity, shards, capacity, ways);
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, hit);
  return hit;
}

function cheHitRatio(
  popularity: ZipfPopularity,
  shards: number,
  capacityKeys: number,
  streams: readonly ReadStream[],
): number {
  const buckets = zipfBuckets(popularity);
  const keys = buckets.map((b) => b.count / Math.max(1, shards));
  const rates = buckets.map(() => 0);
  for (const stream of streams) {
    const hits = stream.missed.map((m) =>
      cacheHitsByBucket(m.input).map((h) => Math.min(1, h * m.scale)),
    );
    // What is left of each bucket's lookups after the caches in front, normalised to the stream's rate.
    const left = buckets.map((b, i) =>
      hits.reduce((share, h) => share * (1 - (h[i] ?? 0)), b.mass),
    );
    const total = left.reduce((sum, x) => sum + x, 0);
    if (total <= 0) continue;
    left.forEach((share, i) => {
      rates[i] = (rates[i] ?? 0) + (stream.rate * share) / total / (buckets[i]?.count ?? 1);
    });
  }
  const reads = keys.reduce((sum, n, i) => sum + n * (rates[i] ?? 0), 0);
  if (reads <= 0) return 1;
  const held = (logTime: number) =>
    keys.reduce((sum, n, i) => sum + n * -Math.expm1(-(rates[i] ?? 0) * Math.exp(logTime)), 0);
  // Every key read at all fits: only cold reads would miss, and there are none in steady state.
  if (held(MAX_LOG_TIME) <= capacityKeys) return 1;
  let low = MIN_LOG_TIME;
  let high = MAX_LOG_TIME;
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (low + high) / 2;
    if (held(mid) < capacityKeys) low = mid;
    else high = mid;
  }
  const time = Math.exp((low + high) / 2);
  const hits = keys.reduce(
    (sum, n, i) => sum + n * (rates[i] ?? 0) * -Math.expm1(-(rates[i] ?? 0) * time),
    0,
  );
  return hits / reads;
}
