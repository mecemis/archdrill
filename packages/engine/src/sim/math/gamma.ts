const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos approximation). */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = 0.99999999999980993;
  LANCZOS.forEach((c, i) => {
    sum += c / (z + i + 1);
  });
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

const MAX_ITERATIONS = 500;
const EPSILON = 1e-14;

/** Regularised lower incomplete gamma function P(a, x). */
export function regularizedGammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) return gammaSeries(a, x);
  return 1 - gammaContinuedFraction(a, x);
}

function gammaSeries(a: number, x: number): number {
  let sum = 1 / a;
  let term = sum;
  for (let n = 1; n < MAX_ITERATIONS; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * EPSILON) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaContinuedFraction(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_ITERATIONS; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** A latency distribution described by its first two moments. */
export interface Moments {
  readonly mean: number;
  readonly variance: number;
}

/** CDF of a Gamma distribution matched to the given mean and variance (degenerate if variance ≈ 0). */
export function momentGammaCdf(x: number, { mean, variance }: Moments): number {
  if (mean <= 0) return 1;
  if (variance <= mean * mean * 1e-9) return x >= mean ? 1 : 0;
  const shape = (mean * mean) / variance;
  const scale = variance / mean;
  return regularizedGammaP(shape, x / scale);
}

export interface WeightedMoments extends Moments {
  readonly weight: number;
}

const BISECTION_STEPS = 80;

/**
 * Quantile of a mixture of moment-matched Gamma distributions, found by
 * bisection on the mixture CDF. Weights need not sum to 1.
 */
export function mixtureQuantile(
  components: readonly WeightedMoments[],
  probability: number,
): number {
  const live = components.filter((c) => c.weight > 0);
  const total = live.reduce((sum, c) => sum + c.weight, 0);
  if (total <= 0) return 0;
  const cdf = (x: number) =>
    live.reduce((sum, c) => sum + c.weight * momentGammaCdf(x, c), 0) / total;
  let low = 0;
  let high = Math.max(...live.map((c) => c.mean + 12 * Math.sqrt(c.variance)), 1e-9);
  while (cdf(high) < probability) high *= 2;
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (low + high) / 2;
    if (cdf(mid) < probability) low = mid;
    else high = mid;
  }
  return high;
}
