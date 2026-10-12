import type { Problem, Scenario } from "@archdrill/model";
import { populateAfterMiss } from "./dataflow";
import { allSuccessPathsContain, noPath, outcomeHandled, statusForCondition } from "./paths";
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
