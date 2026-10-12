import { cacheHitRatio } from "./cache-model";
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
 * Relaxes every cache's hit ratios towards what the current lookup rates
 * give. An in-process cache keeps one copy per instance of its caller, so
 * each copy sees that instance's share of the lookups.
 */
export function relaxCaches(
  caches: readonly CacheSpec[],
  flow: Propagation,
  loop: LoopState,
  damping: number,
  instancesOf: (componentId: string) => number,
): number {
  let delta = 0;
  for (const spec of caches) {
    const key = cacheKey(spec.componentId, spec.entity);
    const total = flow.lookups.get(key) ?? { existing: 0, absent: 0, hot: 0 };
    const copies = spec.callerOf ? Math.max(1, instancesOf(spec.callerOf)) : 1;
    const lookups = {
      existing: total.existing / copies,
      absent: total.absent / copies,
      hot: total.hot / copies,
    };
    const [positiveItems, negativeItems] = splitCapacity(spec, lookups);
    const targets: [Map<string, number>, number][] = [
      [loop.hit, hitFor(spec, lookups.existing, positiveItems)],
      [loop.negativeHit, negativeHitFor(spec, lookups.absent, negativeItems)],
      [loop.hotHit, hotHitFor(spec, lookups.hot)],
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
