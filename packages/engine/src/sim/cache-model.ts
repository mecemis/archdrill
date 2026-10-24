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

interface CapacityProfile {
  readonly masses: readonly number[];
  /** Popularity of one key of each bucket: its share of all lookups. */
  readonly perKey: readonly number[];
  /** Hit probability of a key of each bucket when only capacity limits the cache. */
  readonly capacityHits: readonly number[];
}

const profiles = new Map<string, CapacityProfile>();

/**
 * Che's approximation is scale-free: with a key's rate λ·q_k, the
 * characteristic time solves Σ_k (1 − e^{−q_k·λ·t_C}) = C, so λ·t_C (and with
 * it the hit probability 1 − e^{−q_k·λ·t_C}) does not depend on the rate.
 * It is worked out once per popularity and capacity.
 */
function capacityProfile(popularity: ZipfPopularity, capacityItems: number): CapacityProfile {
  const key = `${popularity.s}|${popularity.population}|${capacityItems}`;
  const known = profiles.get(key);
  if (known) return known;
  const buckets = zipfBuckets(popularity);
  const perKey = buckets.map((b) => b.mass / b.count);
  const totalKeys = buckets.reduce((sum, b) => sum + b.count, 0);
  // Occupancy as a function of rate × time, which is all that matters.
  const occupancy = (logScaledTime: number) =>
    buckets.reduce(
      (sum, b, i) => sum + b.count * -Math.expm1(-(perKey[i] ?? 0) * Math.exp(logScaledTime)),
      0,
    );
  let scaledTime = Number.POSITIVE_INFINITY;
  if (capacityItems < totalKeys) {
    let low = MIN_LOG_TIME;
    let high = MAX_LOG_TIME;
    for (let i = 0; i < BISECTION_STEPS; i++) {
      const mid = (low + high) / 2;
      if (occupancy(mid) < capacityItems) low = mid;
      else high = mid;
    }
    scaledTime = Math.exp((low + high) / 2);
  }
  const profile = {
    masses: buckets.map((b) => b.mass),
    perKey,
    capacityHits: perKey.map((q) =>
      Number.isFinite(scaledTime) ? -Math.expm1(-q * scaledTime) : 1,
    ),
  };
  if (profiles.size >= MEMO_LIMIT) profiles.clear();
  profiles.set(key, profile);
  return profile;
}

/**
 * The same model per popularity bucket of `zipfBuckets`: the probability a
 * lookup of one key of each bucket hits. The popular keys hit, the tail
 * misses; what misses is what a store behind the cache sees.
 */
export function cacheHitsByBucket(input: CacheModelInput): readonly number[] {
  const profile = capacityProfile(input.popularity, Math.max(0, input.capacityItems));
  const ttl = input.ttlSec;
  return profile.perKey.map((q, i) => {
    if (input.rate <= 0 || input.capacityItems <= 0) return 0;
    const lambda = input.rate * q;
    const ttlHit = ttl === null ? 1 : (lambda * ttl) / (1 + lambda * ttl);
    return Math.min(profile.capacityHits[i] ?? 0, ttlHit);
  });
}

/**
 * Steady-state hit ratio of an LRU cache with optional TTL, filled on misses
 * (cache-aside), under Zipf-distributed key popularity.
 *
 * Capacity: Che's approximation. The characteristic time t_C solves
 * Σ_k (1 − e^{−λ_k t_C}) = C, and a key with rate λ_k hits with probability
 * 1 − e^{−λ_k t_C}; that probability does not depend on the total rate.
 * TTL (set on write, not refreshed on read): each TTL cycle has one miss and
 * on average λ_k·T hits, so the hit probability is λ_k·T / (1 + λ_k·T).
 * Combined as the minimum of the two, a documented bound-based approximation.
 */
export function cacheHitRatio(input: CacheModelInput): number {
  if (input.rate <= 0 || input.capacityItems <= 0) return 0;
  // Fixed-point iterations ask for nearly identical inputs. Inputs are rounded to
  // 4 significant digits and the model runs on the rounded values, so the result
  // depends only on the key, never on which caller happened to fill the memo.
  const rate = Number(input.rate.toPrecision(4));
  const capacityItems = Number(input.capacityItems.toPrecision(4));
  const key = [
    rate,
    input.popularity.s,
    input.popularity.population,
    capacityItems,
    input.ttlSec,
  ].join("|");
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const profile = capacityProfile(input.popularity, capacityItems);
  const ttl = input.ttlSec;
  let hit = 0;
  for (let i = 0; i < profile.masses.length; i++) {
    const lambda = rate * (profile.perKey[i] ?? 0);
    const ttlHit = ttl === null ? 1 : (lambda * ttl) / (1 + lambda * ttl);
    hit += (profile.masses[i] ?? 0) * Math.min(profile.capacityHits[i] ?? 0, ttlHit);
  }
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, hit);
  return hit;
}
