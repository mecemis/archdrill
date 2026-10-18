import { catalogIndex, getProblemPack } from "@archdrill/content";
import {
  analyzeAttempt,
  type BreakingPoint,
  type EnvironmentMetrics,
  findBreakingPoint,
  scaledEnvironment,
  simulateEnvironment,
} from "@archdrill/engine";
import type { Attempt } from "@archdrill/model";

/** "×3", "×2.4", "×0.25": as few digits as say it. */
export function factorLabel(factor: number): string {
  const digits = factor >= 10 ? 0 : factor >= 1 ? 1 : 2;
  return `×${Number(factor.toFixed(digits))}`;
}

/** Which load to look at: an environment of a scenario, its traffic multiplied by `factor`. */
export interface WhatIfQuestion {
  readonly attempt: Attempt;
  readonly scenarioId: string;
  readonly environmentId: string;
  readonly factor: number;
}

function inputs(question: Omit<WhatIfQuestion, "factor">) {
  const pack = getProblemPack(question.attempt.problemId);
  const scenario = pack?.scenarios.find((s) => s.id === question.scenarioId);
  const workload = scenario?.workload;
  const environment = workload?.environments.find((e) => e.id === question.environmentId);
  if (!pack || !scenario || !workload || !environment) return null;
  const analysis = analyzeAttempt(question.attempt, {
    catalog: catalogIndex,
    problem: pack.problem,
  });
  const ctx = { attempt: question.attempt, catalog: catalogIndex, problem: pack.problem, analysis };
  return { scenario, workload, environment, ctx };
}

/** The environment simulated with its users' traffic multiplied. */
export function simulateWhatIf(question: WhatIfQuestion): EnvironmentMetrics | null {
  const found = inputs(question);
  if (!found) return null;
  const { workload, environment, ctx } = found;
  const scaled = scaledEnvironment(environment, question.factor, ctx.problem);
  // Named for what it is, so every panel that says "At Peak" says it is a what-if.
  const label = `${environment.label}, traffic ${factorLabel(question.factor)}`;
  return simulateEnvironment(workload, { ...scaled, label }, ctx);
}

/** How far the environment's traffic can grow before the scenario's operations break. */
export function breakingPointOf(question: Omit<WhatIfQuestion, "factor">): BreakingPoint | null {
  const found = inputs(question);
  if (!found) return null;
  const { scenario, workload, environment, ctx } = found;
  return findBreakingPoint(workload, environment, ctx, scenario.focusOperations);
}
