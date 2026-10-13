import {
  type Analysis,
  analyzeAttempt,
  type EnvironmentMetrics,
  type OperationStatus,
  simulateEnvironment,
  simulateTimeline,
  type TimelineMetrics,
} from "@archdrill/engine";
import type { Attempt, CatalogIndex, Issue, Problem, Scenario } from "@archdrill/model";
import { CHECKS } from "./checks/registry";
import { type CheckContext, notApplicable } from "./checks/types";
import { type CheckResult, type Scorecard, scoreScenario, toCheckResult } from "./score";

export type ScenarioResult =
  /** Validation errors in scope: fix these first. */
  | { readonly scenarioId: string; readonly status: "invalid"; readonly blocking: readonly Issue[] }
  /** A focus operation has no runnable flow yet. */
  | {
      readonly scenarioId: string;
      readonly status: "incomplete";
      readonly operations: readonly {
        readonly operation: string;
        readonly status: Readiness;
      }[];
    }
  | {
      readonly scenarioId: string;
      readonly status: "evaluated";
      readonly checks: readonly CheckResult[];
      readonly scorecard: Scorecard;
      /** Simulated metrics per environment; empty when the scenario has no workload. */
      readonly metrics: ReadonlyMap<string, EnvironmentMetrics>;
      /** Simulated timelines, by id; empty when the scenario has none. */
      readonly timelines: ReadonlyMap<string, TimelineMetrics>;
    };

/**
 * Why an operation cannot be evaluated yet. "too-complex" means path
 * enumeration hit its cap: checks over a partial path set could pass a design
 * that fails on a path nobody looked at, so the scenario is not scored.
 */
export type Readiness = OperationStatus | "too-complex";

/**
 * Consumers of an event are optional: a design may handle the work another
 * way (a synchronous check instead of a scan). Those without a flow are
 * skipped, with their labels.
 */
function unusedConsumers(ctx: CheckContext): Map<string, string> {
  const unused = new Map<string, string>();
  for (const operation of ctx.problem.operations) {
    if (operation.trigger.type !== "event") continue;
    if (!ctx.attempt.flows.some((f) => f.operation === operation.id)) {
      unused.set(operation.id, `a "${operation.label}" consumer`);
    }
  }
  return unused;
}

/** Operations a check's parameters refer to. */
function operationsIn(params: unknown): string[] {
  if (typeof params !== "object" || params === null) return [];
  return ["operation", "readOperation"].flatMap((key) => {
    const value = (params as Record<string, unknown>)[key];
    return typeof value === "string" ? [value] : [];
  });
}

function readiness(ctx: CheckContext, operation: string): Readiness {
  const analysis = ctx.analysis.operations.get(operation);
  if (!analysis) return "missing";
  if (analysis.status === "ready" && analysis.truncated) return "too-complex";
  return analysis.status;
}

export interface AttemptEvaluation {
  readonly analysis: Analysis;
  readonly scenarios: readonly ScenarioResult[];
}

export interface EvaluationInput {
  readonly problem: Problem;
  readonly scenarios: readonly Scenario[];
  readonly catalog: CatalogIndex;
}

/** Analyses once and evaluates every scenario against the shared analysis. */
export function evaluateAttempt(attempt: Attempt, input: EvaluationInput): AttemptEvaluation {
  const analysis = analyzeAttempt(attempt, { catalog: input.catalog, problem: input.problem });
  const base = { attempt, problem: input.problem, catalog: input.catalog, analysis };
  return {
    analysis,
    scenarios: input.scenarios.map((scenario) =>
      evaluateScenario(scenario, { ...base, metrics: new Map(), timelines: new Map() }),
    ),
  };
}

export function evaluateScenario(scenario: Scenario, ctx: CheckContext): ScenarioResult {
  const blocking = blockingIssues(scenario, ctx.analysis.issues);
  if (blocking.length > 0) return { scenarioId: scenario.id, status: "invalid", blocking };

  const unused = unusedConsumers(ctx);
  const notReady = scenario.focusOperations
    .filter((operation) => !unused.has(operation))
    .map((operation) => ({ operation, status: readiness(ctx, operation) }))
    .filter((op) => op.status !== "ready");
  if (notReady.length > 0)
    return { scenarioId: scenario.id, status: "incomplete", operations: notReady };

  const scenarioCtx: CheckContext = {
    ...ctx,
    metrics: simulateScenario(scenario, ctx),
    timelines: simulateTimelines(scenario, ctx),
  };
  const checks = scenario.checks.map((instance) => {
    const check = CHECKS.get(instance.use);
    if (!check) throw new Error(`Scenario "${scenario.id}" uses unknown check "${instance.use}".`);
    const params = check.params.parse(instance.params);
    const skipped = operationsIn(params).find((operation) => unused.has(operation));
    const outcome =
      skipped === undefined
        ? check.run(params, scenarioCtx)
        : notApplicable(`This design does not use ${unused.get(skipped)}.`);
    return toCheckResult(instance, outcome);
  });
  return {
    scenarioId: scenario.id,
    status: "evaluated",
    checks,
    scorecard: scoreScenario(scenario, checks),
    metrics: scenarioCtx.metrics,
    timelines: scenarioCtx.timelines,
  };
}

function simulateTimelines(scenario: Scenario, ctx: CheckContext): Map<string, TimelineMetrics> {
  const timelines = new Map<string, TimelineMetrics>();
  const workload = scenario.workload;
  if (!workload) return timelines;
  for (const timeline of workload.timelines) {
    timelines.set(timeline.id, simulateTimeline(workload, timeline, ctx));
  }
  return timelines;
}

function simulateScenario(scenario: Scenario, ctx: CheckContext): Map<string, EnvironmentMetrics> {
  const metrics = new Map<string, EnvironmentMetrics>();
  const workload = scenario.workload;
  if (!workload) return metrics;
  for (const environment of workload.environments) {
    metrics.set(environment.id, simulateEnvironment(workload, environment, ctx));
  }
  return metrics;
}

/**
 * Errors on the shared architecture block every scenario. Errors inside a flow
 * only block scenarios that focus on that operation, so a half-built flow
 * elsewhere does not hide feedback.
 */
function blockingIssues(scenario: Scenario, issues: readonly Issue[]): Issue[] {
  const focus = new Set(scenario.focusOperations);
  return issues.filter((issue) => {
    if (issue.severity !== "error") return false;
    const location = issue.location;
    if (location.type === "flow" || location.type === "step") return focus.has(location.operation);
    return true;
  });
}
