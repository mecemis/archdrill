import type { Attempt, Estimate, Problem } from "@archdrill/model";

/** Within this factor of the answer, either way, an estimate is spot on. */
export const SPOT_ON_FACTOR = 1.25;

export type EstimateBand = "spot-on" | "close" | "off";

export interface EstimateResult {
  readonly estimate: Estimate;
  /** The candidate's answer, if they gave one. */
  readonly value: number | null;
  readonly band: EstimateBand | null;
  /** How many times larger (above 1) or smaller (below 1) than the answer. */
  readonly ratio: number | null;
}

/** How far an estimate is from the answer: spot on, close (within the tolerance) or off. */
export function judgeEstimate(estimate: Estimate, value: number): EstimateResult {
  const ratio = value / estimate.answer;
  const factor = Math.max(ratio, 1 / ratio);
  const band =
    factor <= SPOT_ON_FACTOR ? "spot-on" : factor <= estimate.tolerance ? "close" : "off";
  return { estimate, value, band, ratio };
}

/** The candidate's estimates against the problem's answers, in the problem's order. */
export function evaluateEstimates(attempt: Attempt, problem: Problem): EstimateResult[] {
  return problem.estimates.map((estimate) => {
    const value = attempt.estimates[estimate.id];
    return value === undefined
      ? { estimate, value: null, band: null, ratio: null }
      : judgeEstimate(estimate, value);
  });
}
