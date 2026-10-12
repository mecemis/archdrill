import type { CheckInstance, Dimension, Scenario } from "@archdrill/model";
import type { CheckOutcome } from "./checks/types";

/** A failed gate caps the scenario score so a broken design never looks decent. */
export const GATE_SCORE_CAP = 40;

export const BAND_THRESHOLDS = { passing: 60, strong: 80, excellent: 90 } as const;

/**
 * Open findings cap the band: "strong" requires no critical finding and
 * "excellent" requires no major one, however good the rest of the design is.
 */
export const SEVERITY_SCORE_CAPS = {
  critical: BAND_THRESHOLDS.strong - 1,
  major: BAND_THRESHOLDS.excellent - 1,
} as const;

export type Band = "not-passing" | "passing" | "strong" | "excellent";

export interface CheckResult extends CheckOutcome {
  readonly instance: CheckInstance;
  readonly gateFailed: boolean;
}

export interface DimensionResult {
  readonly dimension: Dimension;
  readonly weight: number;
  /** 0..100, or null when no applicable baseline check covers the dimension yet. */
  readonly score: number | null;
  /** Scored checks that applied to this design. */
  readonly checkCount: number;
  /** Scored checks the scenario defines for this dimension, applicable or not. */
  readonly definedCount: number;
}

export interface SignalSummary {
  readonly demonstrated: number;
  readonly total: number;
}

export interface Scorecard {
  readonly score: number;
  readonly band: Band;
  readonly dimensions: readonly DimensionResult[];
  readonly gateFailures: readonly string[];
  /** Why the score was capped below its weighted value, if it was. */
  readonly cap: { readonly reason: "gate" | "critical" | "major"; readonly value: number } | null;
  readonly signals: { readonly senior: SignalSummary; readonly staff: SignalSummary };
}

export function toCheckResult(instance: CheckInstance, outcome: CheckOutcome): CheckResult {
  const failing = outcome.status === "fail" || outcome.status === "partial";
  return { ...outcome, instance, gateFailed: instance.gate && failing };
}

/**
 * Gates first, then weighted dimensions over applicable baseline checks.
 * Dimensions without applicable checks are reported but excluded, and the
 * remaining dimension weights are renormalised. Finally the score is capped by
 * failed gates and by the most severe open finding.
 */
export function scoreScenario(scenario: Scenario, results: readonly CheckResult[]): Scorecard {
  const dimensions = scoreDimensions(scenario, results);
  const evaluated = dimensions.filter((d) => d.score !== null);
  const weightSum = evaluated.reduce((sum, d) => sum + d.weight, 0);
  const raw =
    weightSum === 0
      ? 0
      : evaluated.reduce((sum, d) => sum + d.weight * (d.score ?? 0), 0) / weightSum;
  const gateFailures = results.filter((r) => r.gateFailed).map((r) => r.instance.id);
  const cap = capFor(results, gateFailures.length > 0);
  const score = Math.round(cap && cap.value < raw ? cap.value : raw);
  return {
    score,
    band: gateFailures.length > 0 ? "not-passing" : bandFor(score),
    dimensions,
    gateFailures,
    cap: cap && cap.value < raw ? cap : null,
    signals: { senior: signals(results, "senior"), staff: signals(results, "staff") },
  };
}

function scoreDimensions(scenario: Scenario, results: readonly CheckResult[]): DimensionResult[] {
  return Object.entries(scenario.dimensions).map(([dimension, weight]) => {
    const scored = results.filter(
      (r) =>
        r.instance.dimension === dimension &&
        r.instance.signal === "baseline" &&
        r.instance.weight > 0 &&
        r.status !== "n/a",
    );
    const definedCount = results.filter(
      (r) =>
        r.instance.dimension === dimension &&
        r.instance.signal === "baseline" &&
        r.instance.weight > 0,
    ).length;
    const totalWeight = scored.reduce((sum, r) => sum + r.instance.weight, 0);
    const earned = scored.reduce((sum, r) => sum + r.instance.weight * r.fraction, 0);
    return {
      dimension: dimension as Dimension,
      weight: weight ?? 0,
      score: totalWeight === 0 ? null : (100 * earned) / totalWeight,
      checkCount: scored.length,
      definedCount,
    };
  });
}

function capFor(results: readonly CheckResult[], gateFailed: boolean): Scorecard["cap"] {
  if (gateFailed) return { reason: "gate", value: GATE_SCORE_CAP };
  const open = results.filter(
    (r) =>
      r.instance.signal === "baseline" &&
      r.instance.weight > 0 &&
      (r.status === "fail" || r.status === "partial"),
  );
  if (open.some((r) => r.instance.severity === "critical")) {
    return { reason: "critical", value: SEVERITY_SCORE_CAPS.critical };
  }
  if (open.some((r) => r.instance.severity === "major")) {
    return { reason: "major", value: SEVERITY_SCORE_CAPS.major };
  }
  return null;
}

export function bandFor(score: number): Band {
  if (score >= BAND_THRESHOLDS.excellent) return "excellent";
  if (score >= BAND_THRESHOLDS.strong) return "strong";
  if (score >= BAND_THRESHOLDS.passing) return "passing";
  return "not-passing";
}

function signals(results: readonly CheckResult[], level: "senior" | "staff"): SignalSummary {
  const relevant = results.filter((r) => r.instance.signal === level);
  return {
    demonstrated: relevant.filter((r) => r.status === "pass").length,
    total: relevant.length,
  };
}
