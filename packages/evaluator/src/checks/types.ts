import type { Analysis, EnvironmentMetrics, OperationAnalysis } from "@archdrill/engine";
import type { Attempt, CatalogIndex, Problem } from "@archdrill/model";
import type { z } from "zod";
import type { Evidence } from "../evidence";

export interface CheckContext {
  readonly attempt: Attempt;
  readonly problem: Problem;
  readonly catalog: CatalogIndex;
  readonly analysis: Analysis;
  /** Simulated metrics per environment of the scenario being evaluated; empty without a workload. */
  readonly metrics: ReadonlyMap<string, EnvironmentMetrics>;
}

export type CheckStatus = "pass" | "partial" | "fail" | "n/a";

export interface CheckOutcome {
  readonly status: CheckStatus;
  /** Share of credit earned, 0..1. Always 1 for pass and 0 for n/a. */
  readonly fraction: number;
  /** One sentence describing what was found in this design. */
  readonly message: string;
  /** Optional supporting lines, e.g. the offending paths. */
  readonly details: readonly string[];
  readonly evidence: readonly Evidence[];
  /** Structured facts for the UI, e.g. the strategy a design was recognised as. */
  readonly data?: Readonly<Record<string, string>>;
}

export interface CheckDef<S extends z.ZodType = z.ZodType> {
  readonly id: string;
  /** What the check verifies, independent of any scenario. */
  readonly description: string;
  readonly params: S;
  readonly run: (params: z.output<S>, ctx: CheckContext) => CheckOutcome;
}

export function defineCheck<S extends z.ZodType>(def: CheckDef<S>): CheckDef<S> {
  return def;
}

export function notApplicable(message: string): CheckOutcome {
  return { status: "n/a", fraction: 0, message, details: [], evidence: [] };
}

export function passed(message: string): CheckOutcome {
  return { status: "pass", fraction: 1, message, details: [], evidence: [] };
}

/** Builds pass/partial/fail from a ratio of satisfied items. */
export function graded(
  satisfied: number,
  total: number,
  message: string,
  evidence: readonly Evidence[],
  details: readonly string[] = [],
): CheckOutcome {
  const fraction = total === 0 ? 1 : satisfied / total;
  const status = fraction >= 1 ? "pass" : fraction > 0 ? "partial" : "fail";
  return { status, fraction, message, details, evidence };
}

export function failed(
  message: string,
  evidence: readonly Evidence[],
  details: readonly string[] = [],
): CheckOutcome {
  return { status: "fail", fraction: 0, message, details, evidence };
}

/** Looks up an operation that the check params refer to; content validation guarantees it exists. */
export function requireOperation(ctx: CheckContext, operation: string): OperationAnalysis {
  const analysis = ctx.analysis.operations.get(operation);
  if (!analysis) throw new Error(`Check refers to unknown operation "${operation}".`);
  return analysis;
}

export const MAX_DETAIL_LINES = 4;
