import type { Problem, Scenario } from "@archdrill/model";
import { populateAfterMiss } from "./dataflow";
import { ingressHasCapability } from "./ingress";
import {
  costWithinBudget,
  hitRatioAbove,
  latencyBelow,
  successRateAbove,
  utilizationBelow,
} from "./metrics";
import { allSuccessPathsContain, noPath, outcomeHandled, statusForCondition } from "./paths";
import { recognizeStrategy } from "./strategy";
import { noSinglePointOfFailure, unusedComponents } from "./topology";
import type { CheckDef } from "./types";

export const CHECKS: ReadonlyMap<string, CheckDef> = new Map<string, CheckDef>(
  [
    outcomeHandled,
    noPath,
    allSuccessPathsContain,
    statusForCondition,
    populateAfterMiss,
    noSinglePointOfFailure,
    unusedComponents,
    latencyBelow,
    utilizationBelow,
    successRateAbove,
    hitRatioAbove,
    costWithinBudget,
    recognizeStrategy,
    ingressHasCapability,
  ].map((check) => [check.id, check as CheckDef]),
);

export interface ScenarioConfigIssue {
  readonly checkId: string;
  readonly message: string;
}

/**
 * Validates that a scenario only uses known checks with valid parameters and
 * refers to operations and requirements the problem defines. Used by content
 * tests so authoring mistakes fail the build.
 */
export function validateScenarioConfig(
  scenario: Scenario,
  problem: Problem,
): ScenarioConfigIssue[] {
  const issues: ScenarioConfigIssue[] = [];
  const operations = new Set(problem.operations.map((o) => o.id));
  const requirements = new Set(problem.requirements.map((r) => r.id));
  for (const op of scenario.focusOperations) {
    if (!operations.has(op))
      issues.push({ checkId: "-", message: `unknown focus operation "${op}"` });
  }
  for (const instance of scenario.checks) {
    const check = CHECKS.get(instance.use);
    if (!check) {
      issues.push({ checkId: instance.id, message: `unknown check "${instance.use}"` });
      continue;
    }
    const parsed = check.params.safeParse(instance.params);
    if (!parsed.success) {
      issues.push({ checkId: instance.id, message: parsed.error.message });
      continue;
    }
    const environment = (parsed.data as { environment?: unknown }).environment;
    if (
      typeof environment === "string" &&
      !scenario.workload?.environments.some((e) => e.id === environment)
    ) {
      issues.push({ checkId: instance.id, message: `unknown environment "${environment}"` });
    }
    const op = (parsed.data as { operation?: unknown }).operation;
    if (typeof op === "string" && !operations.has(op)) {
      issues.push({ checkId: instance.id, message: `unknown operation "${op}"` });
    }
    for (const req of instance.requirements) {
      if (!requirements.has(req))
        issues.push({ checkId: instance.id, message: `unknown requirement "${req}"` });
    }
  }
  return issues;
}
