/** Terms summed exactly before switching to the Euler–Maclaurin tail. */
const EXACT_TERMS = 10_000;

const prefixCache = new Map<number, Float64Array>();

function prefixSums(s: number): Float64Array {
  const cached = prefixCache.get(s);
  if (cached) return cached;
  const sums = new Float64Array(EXACT_TERMS + 1);
  for (let k = 1; k <= EXACT_TERMS; k++) sums[k] = (sums[k - 1] ?? 0) + k ** -s;
  prefixCache.set(s, sums);
  return sums;
}

/** ∫_a^b x^-s dx */
function powerIntegral(a: number, b: number, s: number): number {
  return s === 1 ? Math.log(b / a) : (b ** (1 - s) - a ** (1 - s)) / (1 - s);
}

/**
 * Generalised harmonic number H(n, s) = Σ_{k=1..n} k^-s. Exact for the first
 * terms; beyond that the Euler–Maclaurin formula, accurate to ~1e-12 relative
 * for the populations used here (up to ~10^11 keys).
 */
export function harmonic(n: number, s: number): number {
  const terms = Math.floor(n);
  if (terms <= 0) return 0;
  const sums = prefixSums(s);
  if (terms <= EXACT_TERMS) return sums[terms] ?? 0;
  const m = EXACT_TERMS;
  const f = (x: number) => x ** -s;
  const df = (x: number) => -s * x ** (-s - 1);
  const tail = powerIntegral(m, terms, s) + (f(terms) - f(m)) / 2 + (df(terms) - df(m)) / 12;
  return (sums[m] ?? 0) + tail;
}
