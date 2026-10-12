import type { EnvironmentMetrics } from "@archdrill/engine";
import { z } from "zod";
import type { Evidence } from "../evidence";
import {
  type CheckContext,
  type CheckOutcome,
  defineCheck,
  failed,
  notApplicable,
  passed,
} from "./types";

const EnvironmentParam = z.string().min(1);
/** A target missed by more than this factor earns no partial credit. */
const PARTIAL_LIMIT = 1.5;

function environmentOf(ctx: CheckContext, id: string): EnvironmentMetrics | null {
  return ctx.metrics.get(id) ?? null;
}

function label(ctx: CheckContext, componentId: string): string {
  return (
    ctx.attempt.architecture.components.find((c) => c.id === componentId)?.label ?? componentId
  );
}

const percent = (value: number) => `${(value * 100).toFixed(value > 0.999 && value < 1 ? 2 : 1)}%`;
const ms = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
export const usd = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;

/** Credit for a "lower is better" metric: full at or below the target, partial up to PARTIAL_LIMIT× over it. */
function gradeAtMost(
  actual: number,
  target: number,
  message: string,
  evidence: readonly Evidence[],
): CheckOutcome {
  if (actual <= target) return passed(message);
  if (actual <= target * PARTIAL_LIMIT) {
    return { status: "partial", fraction: target / actual, message, details: [], evidence };
  }
  return failed(message, evidence);
}

function hotComponents(env: EnvironmentMetrics, threshold: number): Evidence[] {
  return [...env.components.values()]
    .filter((c) => c.utilization > threshold)
    .map((c) => ({ type: "component", componentId: c.componentId }));
}

/** Latency percentile of an operation under a scenario environment. */
export const latencyBelow = defineCheck({
  id: "latency-below",
  description: "An operation's latency percentile stays under a target.",
  params: z.strictObject({
    operation: z.string().min(1),
    environment: EnvironmentParam,
    percentile: z.enum(["p50", "p95", "p99"]),
    ms: z.number().positive(),
  }),
  run(params, ctx) {
    const env = environmentOf(ctx, params.environment);
    const op = env?.operations.get(params.operation);
    if (!env || !op) return notApplicable("This scenario does not simulate that operation.");
    const actual = op.latency[params.percentile];
    const slow = op.paths
      .filter((p) => p.probability > 0.001 && p.latency.p99 > params.ms)
      .map((p): Evidence => ({ type: "path", operation: params.operation, pathId: p.pathId }));
    const message = `${params.percentile} is ${ms(actual)} at ${env.environment.label}; the target is under ${ms(params.ms)}.`;
    return gradeAtMost(actual, params.ms, message, [...slow, ...hotComponents(env, 0.8)]);
  },
});

/** No component runs hotter than the limit; any component over capacity fails the check. */
export const utilizationBelow = defineCheck({
  id: "utilization-below",
  description: "Every component keeps headroom under the scenario's load.",
  params: z.strictObject({ environment: EnvironmentParam, max: z.number().positive().max(1) }),
  run(params, ctx) {
    const env = environmentOf(ctx, params.environment);
    if (!env) return notApplicable("This scenario does not simulate load.");
    const hot = [...env.components.values()]
      .filter((c) => c.utilization > params.max)
      .sort((a, b) => b.utilization - a.utilization);
    if (hot.length === 0) {
      const peak = Math.max(0, ...[...env.components.values()].map((c) => c.utilization));
      return passed(`The busiest component runs at ${percent(peak)} at ${env.environment.label}.`);
    }
    const evidence: Evidence[] = hot.map((c) => ({
      type: "component",
      componentId: c.componentId,
    }));
    const details = hot.map(
      (c) => `${label(ctx, c.componentId)}: ${percent(c.utilization)} utilised`,
    );
    const overloaded = hot.some((c) => c.utilization > 1);
    const message = overloaded
      ? `${label(ctx, hot[0]?.componentId ?? "")} is over capacity at ${env.environment.label} and rejects requests.`
      : `${hot.length} component(s) run above ${percent(params.max)} at ${env.environment.label}, leaving no headroom.`;
    return overloaded
      ? failed(message, evidence, details)
      : { status: "partial", fraction: 0.5, message, details, evidence };
  },
});

/** Share of requests answered correctly under load (overload and unhandled outcomes count as failures). */
export const successRateAbove = defineCheck({
  id: "success-rate-above",
  description: "An operation keeps answering correctly under the scenario's load.",
  params: z.strictObject({
    operation: z.string().min(1),
    environment: EnvironmentParam,
    min: z.number().min(0).max(1),
  }),
  run(params, ctx) {
    const env = environmentOf(ctx, params.environment);
    const op = env?.operations.get(params.operation);
    if (!env || !op) return notApplicable("This scenario does not simulate that operation.");
    const base = `${percent(op.successRate)} of requests succeed at ${env.environment.label}; the target is ${percent(params.min)}.`;
    if (op.successRate >= params.min) return passed(base);
    const { rejected, unhandled, errorStatus } = op.failures;
    const causes = [
      rejected > 0 ? `${percent(rejected)} rejected by overloaded components on the way in` : null,
      errorStatus > 0 ? `${percent(errorStatus)} answered with an error status` : null,
      unhandled > 0 ? `${percent(unhandled)} end at an outcome the flow does not handle` : null,
    ].filter((c): c is string => c !== null);
    const unhandledPaths: Evidence[] = (ctx.analysis.operations.get(params.operation)?.paths ?? [])
      .filter((p) => p.terminal.kind === "unhandled")
      .map((p) => ({ type: "path", operation: params.operation, pathId: p.id }));
    return failed(`${base} Failures: ${causes.join("; ")}.`, [
      ...hotComponents(env, 1),
      ...unhandledPaths,
    ]);
  },
});

/** Lookup-weighted hit ratio of the caches that serve an entity. */
export const hitRatioAbove = defineCheck({
  id: "hit-ratio-above",
  description: "Caches in front of an entity absorb most reads.",
  params: z.strictObject({
    entity: z.string().min(1),
    environment: EnvironmentParam,
    min: z.number().min(0).max(1),
  }),
  run(params, ctx) {
    const env = environmentOf(ctx, params.environment);
    const caches = env?.caches.filter((c) => c.entity === params.entity) ?? [];
    if (!env || caches.length === 0) return notApplicable(`No cache serves ${params.entity}.`);
    const lookups = caches.reduce((sum, c) => sum + c.lookupRate, 0);
    const ratio =
      lookups > 0 ? caches.reduce((sum, c) => sum + c.hitRatio * c.lookupRate, 0) / lookups : 0;
    const evidence: Evidence[] = caches.map((c) => ({
      type: "component",
      componentId: c.componentId,
    }));
    const unwarmed = caches.filter((c) => !c.populated).map((c) => label(ctx, c.componentId));
    const why =
      unwarmed.length > 0 ? ` Nothing writes to ${unwarmed.join(", ")}, so it never warms.` : "";
    const message = `Hit ratio for ${params.entity} is ${percent(ratio)} at ${env.environment.label}; the target is ${percent(params.min)}.${why}`;
    if (ratio >= params.min) return passed(message);
    return {
      status: ratio > 0 ? "partial" : "fail",
      fraction: ratio / params.min,
      message,
      details: [],
      evidence,
    };
  },
});

/** Monthly cost of the design under the scenario's load stays within a budget. */
export const costWithinBudget = defineCheck({
  id: "cost-within-budget",
  description: "The design's monthly cost stays within the budget.",
  params: z.strictObject({ environment: EnvironmentParam, monthlyUsd: z.number().positive() }),
  run(params, ctx) {
    const env = environmentOf(ctx, params.environment);
    if (!env) return notApplicable("This scenario does not simulate load.");
    const top = [...env.components.values()]
      .sort((a, b) => b.monthlyCost - a.monthlyCost)
      .slice(0, 3);
    const details = top.map((c) => `${label(ctx, c.componentId)}: ${usd(c.monthlyCost)}/month`);
    const evidence: Evidence[] = top.map((c) => ({
      type: "component",
      componentId: c.componentId,
    }));
    const message = `The design costs about ${usd(env.monthlyCost)}/month at ${env.environment.label}; the budget is ${usd(params.monthlyUsd)}.`;
    const outcome = gradeAtMost(env.monthlyCost, params.monthlyUsd, message, evidence);
    return { ...outcome, details };
  },
});
