import { type ZipfPopularity, zipfBuckets } from "./math/zipf";

export interface CacheModelInput {
  /** Requests per second that look up keys of this population in the cache. */
  readonly rate: number;
  readonly popularity: ZipfPopularity;
  /** How many entries fit in the cache memory set aside for these keys. */
  readonly capacityItems: number;
  /** Time-to-live of entries written on a miss; null means no expiry. */
  readonly ttlSec: number | null;
}

const BISECTION_STEPS = 64;
const MEMO_LIMIT = 512;
const memo = new Map<string, number>();
const MIN_LOG_TIME = Math.log(1e-9);
const MAX_LOG_TIME = Math.log(1e15);

/**
 * Steady-state hit ratio of an LRU cache with optional TTL, filled on misses
 * (cache-aside), under Zipf-distributed key popularity.
 *
 * Capacity: Che's approximation. The characteristic time t_C solves
 * Σ_k (1 − e^{−λ_k t_C}) = C, and a key with rate λ_k hits with probability
 * 1 − e^{−λ_k t_C}.
 * TTL (set on write, not refreshed on read): each TTL cycle has one miss and
 * on average λ_k·T hits, so the hit probability is λ_k·T / (1 + λ_k·T).
 * Combined as the minimum of the two, a documented bound-based approximation.
 */
export function cacheHitRatio(input: CacheModelInput): number {
  if (input.rate <= 0 || input.capacityItems <= 0) return 0;
  // Fixed-point iterations ask for nearly identical inputs; 4 significant digits is plenty.
  const key = [
    input.rate.toPrecision(4),
    input.popularity.s,
    input.popularity.population,
    input.capacityItems.toPrecision(4),
    input.ttlSec,
  ].join("|");
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const result = computeHitRatio(input);
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, result);
  return result;
}

function computeHitRatio({ rate, popularity, capacityItems, ttlSec }: CacheModelInput): number {
  const buckets = zipfBuckets(popularity);
  const perKeyRate = buckets.map((b) => (rate * b.mass) / b.count);
  const totalKeys = buckets.reduce((sum, b) => sum + b.count, 0);
  const occupancy = (logTime: number) =>
    buckets.reduce(
      (sum, b, i) => sum + b.count * -Math.expm1(-(perKeyRate[i] ?? 0) * Math.exp(logTime)),
      0,
    );

  let characteristicTime = Number.POSITIVE_INFINITY;
  if (capacityItems < totalKeys) {
    let low = MIN_LOG_TIME;
    let high = MAX_LOG_TIME;
    for (let i = 0; i < BISECTION_STEPS; i++) {
      const mid = (low + high) / 2;
      if (occupancy(mid) < capacityItems) low = mid;
      else high = mid;
    }
    characteristicTime = Math.exp((low + high) / 2);
  }

  return buckets.reduce((sum, b, i) => {
    const lambda = perKeyRate[i] ?? 0;
    const capacityHit = Number.isFinite(characteristicTime)
      ? -Math.expm1(-lambda * characteristicTime)
      : 1;
    const ttlHit = ttlSec === null ? 1 : (lambda * ttlSec) / (1 + lambda * ttlSec);
    return sum + b.mass * Math.min(capacityHit, ttlHit);
  }, 0);
}
