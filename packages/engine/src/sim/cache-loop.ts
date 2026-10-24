import { cacheHitRatio } from "./cache-model";
import type { MissedCache } from "./page-cache";
import type { LoopState } from "./propagate";
import { type CacheSpec, cacheKey } from "./setup";
import type { Propagation } from "./summary";

/**
 * Positive and negative entries compete for the same memory. Without negative
 * caching all of it holds positive entries; with it, memory is shared in
 * proportion to lookups, a simple and documented approximation.
 */
function splitCapacity(
  spec: CacheSpec,
  lookups: { existing: number; absent: number },
): [number, number] {
  if (!spec.negativePopulated) return [spec.capacityItems, 0];
  const total = lookups.existing + lookups.absent;
  if (total <= 0) return [spec.capacityItems, 0];
  const negativeShare = lookups.absent / total;
  return [spec.capacityItems * (1 - negativeShare), spec.capacityItems * negativeShare];
}

function hitFor(spec: CacheSpec, rate: number, capacityItems: number): number {
  if (!spec.populated || !spec.existing) return 0;
  return cacheHitRatio({ rate, popularity: spec.existing, capacityItems, ttlSec: spec.ttlSec });
}

function negativeHitFor(spec: CacheSpec, rate: number, capacityItems: number): number {
  if (!spec.negativePopulated || !spec.absent) return 0;
  return cacheHitRatio({
    rate,
    popularity: spec.absent,
    capacityItems,
    ttlSec: spec.negativeTtlSec,
  });
}

/**
 * The hot key is the most popular one, so it stays in any cache that holds
 * anything; it only misses when its TTL expires: a share 1/(1 + λT) of its
 * lookups at rate λ.
 */
function hotHitFor(spec: CacheSpec, rate: number): number {
  if (!spec.populated || spec.capacityItems < 1 || rate <= 0) return 0;
  if (spec.ttlSec === null) return 1;
  const visits = rate * spec.ttlSec;
  return visits / (1 + visits);
}

/**
 * Hit ratio when only a share `fill` of misses writes the entry back. Each
 * write is followed by about h/(1 − h) hits before the entry goes; with a
 * write on only a share of misses, about 1/fill misses come between them.
 */
export function withFill(hit: number, fill: number): number {
  if (fill >= 1) return hit;
  if (fill <= 0 || hit <= 0) return 0;
  if (hit >= 1) return 1;
  return (hit * fill) / (hit * fill + 1 - hit);
}

/**
 * Environments judge the first minutes of a fault: an entry written before it
 * outlives it if its TTL is long against this horizon.
 */
export const FAULT_HORIZON_SEC = 300;

/**
 * Share of the hot key's misses that write it back, from the current miss
 * rate. Entries with a TTL long against the fault horizon persist from before
 * a fault even if nothing writes them now; short-lived ones (a one-second
 * block) need the writes.
 */
function hotFillShare(spec: CacheSpec, fills: number, lookups: number, currentHit: number): number {
  const misses = lookups * (1 - currentHit);
  const written = misses > 1e-9 ? Math.min(1, fills / misses) : 1;
  const ttl = spec.ttlSec;
  const persisting = ttl === null ? 1 : Math.max(0, 1 - FAULT_HORIZON_SEC / (2 * ttl));
  return Math.max(written, persisting);
}

/**
 * Relaxes every cache's hit ratios towards what the current lookup rates
 * give. An in-process cache keeps one copy per instance of its caller, so
 * each copy sees that instance's share of the lookups.
 */
/**
 * A cache that started empty `window` seconds ago holds only what was asked
 * for since: no entry can be older than that, which caps its TTL.
 */
function warmedFor(spec: CacheSpec, window: number | undefined): CacheSpec {
  if (window === undefined) return spec;
  const cap = (ttl: number | null) => Math.max(0, ttl === null ? window : Math.min(ttl, window));
  return { ...spec, ttlSec: cap(spec.ttlSec), negativeTtlSec: cap(spec.negativeTtlSec) };
}

export function relaxCaches(
  caches: readonly CacheSpec[],
  flow: Propagation,
  loop: LoopState,
  damping: number,
  instancesOf: (componentId: string) => number,
  windowOf: (key: string) => number | undefined = () => undefined,
): number {
  let delta = 0;
  for (const cache of caches) {
    const key = cacheKey(cache.componentId, cache.entity);
    const spec = warmedFor(cache, windowOf(key));
    const total = flow.lookups.get(key) ?? { existing: 0, absent: 0, hot: 0 };
    const copies = spec.callerOf ? Math.max(1, instancesOf(spec.callerOf)) : 1;
    const lookups = {
      existing: total.existing / copies,
      absent: total.absent / copies,
      hot: total.hot / copies,
    };
    const [positiveItems, negativeItems] = splitCapacity(spec, lookups);
    const written = flow.fills.get(key)?.hot ?? 0;
    const hotFill = hotFillShare(spec, written / copies, lookups.hot, loop.hotHit.get(key) ?? 0);
    const targets: [Map<string, number>, number][] = [
      [loop.hit, hitFor(spec, lookups.existing, positiveItems)],
      [loop.negativeHit, negativeHitFor(spec, lookups.absent, negativeItems)],
      [loop.hotHit, withFill(hotHitFor(spec, lookups.hot), hotFill)],
    ];
    for (const [values, target] of targets) {
      const current = values.get(key) ?? 0;
      const next = current + damping * (target - current);
      values.set(key, next);
      delta = Math.max(delta, Math.abs(next - current));
    }
  }
  return delta;
}

/**
 * What gives the probability a cache answers a lookup of one key of each
 * popularity bucket: the cache model at its current lookups and memory, and
 * a scale that makes it give, over all keys, the hit ratio the fixed point
 * has reached (which also counts how warm the cache is and how often a miss
 * writes the entry back).
 */
export function bucketHitsInput(
  cache: CacheSpec,
  flow: Propagation,
  loop: LoopState,
  instancesOf: (componentId: string) => number,
  windowOf: (key: string) => number | undefined = () => undefined,
): MissedCache | null {
  const key = cacheKey(cache.componentId, cache.entity);
  const spec = warmedFor(cache, windowOf(key));
  if (!spec.populated || !spec.existing) return null;
  const total = flow.lookups.get(key) ?? { existing: 0, absent: 0, hot: 0 };
  const copies = spec.callerOf ? Math.max(1, instancesOf(spec.callerOf)) : 1;
  const lookups = { existing: total.existing / copies, absent: total.absent / copies, hot: 0 };
  const [positiveItems] = splitCapacity(spec, lookups);
  const input = {
    rate: lookups.existing,
    popularity: spec.existing,
    capacityItems: positiveItems,
    ttlSec: spec.ttlSec,
  };
  const modelled = cacheHitRatio(input);
  const reached = loop.hit.get(key) ?? 0;
  return { input, scale: modelled > 0 ? reached / modelled : 0 };
}
