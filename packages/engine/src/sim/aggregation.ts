import { type ZipfPopularity, zipfBuckets } from "./math/zipf";

/**
 * Writes per arriving item when a handler sums what arrives per key over a
 * window and writes each key once per window: distinct keys over items.
 *
 * With items arriving at rate λ for keys of Zipf popularity q_k, a window of
 * W seconds sees key k with probability 1 − e^{−λ·q_k·W} (Poisson arrivals),
 * so it writes Σ_k (1 − e^{−λ·q_k·W}) times for λ·W items. Popular keys
 * collapse into one write each; the long tail barely shrinks.
 */
export function windowWriteShare(
  rate: number,
  windowSec: number,
  popularity: ZipfPopularity | undefined,
): number {
  const items = rate * windowSec;
  if (items <= 1 || !popularity) return 1;
  // Iterations ask for nearly identical rates; the share depends on the rounded inputs only.
  const rounded = Number(items.toPrecision(4));
  const key = `${rounded}|${popularity.s}|${popularity.population}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  let writes = 0;
  for (const bucket of zipfBuckets(popularity)) {
    writes += bucket.count * -Math.expm1(-rounded * (bucket.mass / bucket.count));
  }
  const share = Math.min(1, writes / rounded);
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, share);
  return share;
}

/** One key that every item asks for is written once per window. */
export function hotWindowShare(rate: number, windowSec: number): number {
  const items = rate * windowSec;
  return items <= 1 ? 1 : 1 / items;
}

const MEMO_LIMIT = 512;
const memo = new Map<string, number>();
