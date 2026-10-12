import { type Analysis, analyzeAttempt, type OperationStatus } from "@archdrill/engine";
import type { Attempt, CatalogIndex, Issue, Problem, Scenario } from "@archdrill/model";
import { CHECKS } from "./checks/registry";
import type { CheckContext } from "./checks/types";
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
        readonly status: OperationStatus;
      }[];
    }
  | {
      readonly scenarioId: string;
      readonly status: "evaluated";
      readonly checks: readonly CheckResult[];
      readonly scorecard: Scorecard;
    };

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
  const ctx: CheckContext = { attempt, problem: input.problem, catalog: input.catalog, analysis };
  return {
    analysis,
    scenarios: input.scenarios.map((scenario) => evaluateScenario(scenario, ctx)),
  };
}

export function evaluateScenario(scenario: Scenario, ctx: CheckContext): ScenarioResult {
  const blocking = blockingIssues(scenario, ctx.analysis.issues);
  if (blocking.length > 0) return { scenarioId: scenario.id, status: "invalid", blocking };

  const notReady = scenario.focusOperations
    .map((operation) => ({
      operation,
      status: ctx.analysis.operations.get(operation)?.status ?? "missing",
    }))
    .filter((op) => op.status !== "ready");
  if (notReady.length > 0)
    return { scenarioId: scenario.id, status: "incomplete", operations: notReady };

  const checks = scenario.checks.map((instance) => {
    const check = CHECKS.get(instance.use);
    if (!check) throw new Error(`Scenario "${scenario.id}" uses unknown check "${instance.use}".`);
    const params = check.params.parse(instance.params);
    return toCheckResult(instance, check.run(params, ctx));
  });
  return {
    scenarioId: scenario.id,
    status: "evaluated",
    checks,
    scorecard: scoreScenario(scenario, checks),
  };
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
