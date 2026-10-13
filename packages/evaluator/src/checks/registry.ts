import { type Problem, REPLICATION_MODES, type Scenario } from "@archdrill/model";
import { invalidationOnWrite } from "./consistency";
import { populateAfterMiss } from "./dataflow";
import { decisionExcludes } from "./decisions";
import { noAcknowledgedDataLoss } from "./durability";
import { ingressHasCapability } from "./ingress";
import {
  backlogStable,
  costWithinBudget,
  hitRatioAbove,
  latencyBelow,
  successRateAbove,
  utilizationBelow,
} from "./metrics";
import { allSuccessPathsContain, noPath, outcomeHandled, statusForCondition } from "./paths";
import {
  circuitBreakerOnDependency,
  dependencyTimeoutBounded,
  retriesBoundedWithJitter,
  retryOnlyIdempotent,
  stableUnderRetries,
} from "./resilience";
import { unsafeContentStopped } from "./safety";
import { autoscalingConfigured, overprovisioned } from "./scale";
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
    dependencyTimeoutBounded,
    retriesBoundedWithJitter,
    retryOnlyIdempotent,
    circuitBreakerOnDependency,
    stableUnderRetries,
    noAcknowledgedDataLoss,
    invalidationOnWrite,
    decisionExcludes,
    overprovisioned,
    autoscalingConfigured,
    backlogStable,
    unsafeContentStopped,
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
    const decision = (parsed.data as { decision?: unknown }).decision;
    if (
      instance.use === "no-acknowledged-data-loss" &&
      decision !== scenario.workload?.replication?.decision
    ) {
      issues.push({
        checkId: instance.id,
        message: `decision "${String(decision)}" must be the workload's replication decision, so the simulated latency and the durability verdict agree`,
      });
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
  return [...issues, ...validateWorkload(scenario, problem)];
}

/** A positive whole number, as code-length options must be. */
const CODE_LENGTH = /^[1-9]\d*$/;

/**
 * Cross-checks a workload against its problem. Mistakes here would not fail
 * loudly: the simulator would quietly leave out an operation or a keyspace.
 */
function validateWorkload(scenario: Scenario, problem: Problem): ScenarioConfigIssue[] {
  const workload = scenario.workload;
  if (!workload) return [];
  const issue = (message: string): ScenarioConfigIssue => ({ checkId: "workload", message });
  const issues: ScenarioConfigIssue[] = [];
  const operations = new Set(problem.operations.map((o) => o.id));
  const entities = new Set(problem.entities.map((e) => e.name));
  for (const [id, op] of Object.entries(workload.operations)) {
    if (!operations.has(id)) issues.push(issue(`unknown operation "${id}"`));
    if (!entities.has(op.entity))
      issues.push(issue(`operation "${id}" uses unknown entity "${op.entity}"`));
  }
  for (const env of workload.environments) {
    for (const [id, shares] of Object.entries(env.classShares)) {
      const classes = workload.operations[id]?.classes ?? [];
      const unknown = Object.keys(shares).filter((c) => !classes.some((cls) => cls.id === c));
      if (unknown.length > 0)
        issues.push(
          issue(
            `environment "${env.id}" sets shares for unknown classes of "${id}": ${unknown.join(", ")}`,
          ),
        );
      const total = classes.reduce((sum, cls) => sum + (shares[cls.id] ?? cls.share), 0);
      if (Math.abs(total - 1) > 1e-9)
        issues.push(
          issue(`environment "${env.id}" gives "${id}" class shares that add up to ${total}`),
        );
    }
    for (const id of Object.keys(env.rates)) {
      const trigger = problem.operations.find((o) => o.id === id)?.trigger;
      if (trigger?.type === "event")
        issues.push(
          issue(
            `environment "${env.id}" sets a rate for "${id}", whose rate follows from the flows that publish ${trigger.event}`,
          ),
        );
      else if (!(id in workload.operations))
        issues.push(
          issue(`environment "${env.id}" sets a rate for "${id}", which has no workload`),
        );
    }
  }
  for (const [entity, { lengthDecision }] of Object.entries(workload.keyspace)) {
    if (workload.dataset[entity] === undefined)
      issues.push(issue(`keyspace for ${entity} needs a dataset size`));
    const point = problem.decisionPoints.find((d) => d.id === lengthDecision);
    if (!point) {
      issues.push(issue(`keyspace for ${entity} uses unknown decision "${lengthDecision}"`));
      continue;
    }
    if (point.default === undefined)
      issues.push(issue(`decision "${lengthDecision}" needs a default code length`));
    const lengths = point.options.filter((o) => !CODE_LENGTH.test(o.id)).map((o) => o.id);
    if (lengths.length > 0)
      issues.push(
        issue(
          `decision "${lengthDecision}" has options that are not code lengths: ${lengths.join(", ")}`,
        ),
      );
  }
  const replication = workload.replication?.decision;
  if (replication) {
    const point = problem.decisionPoints.find((d) => d.id === replication);
    const modes: readonly string[] = REPLICATION_MODES;
    if (!point) issues.push(issue(`replication uses unknown decision "${replication}"`));
    else if (point.options.some((o) => !modes.includes(o.id)))
      issues.push(issue(`decision "${replication}" must offer only ${modes.join(", ")}`));
  }
  return issues;
}
