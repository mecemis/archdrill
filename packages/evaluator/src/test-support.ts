import { analyzeAttempt } from "@archdrill/engine";
import {
  type Attempt,
  applyCommand,
  type CommandArgs,
  type CommandName,
  type Scenario,
  ScenarioSchema,
} from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { CHECKS } from "./checks/registry";
import type { CheckContext, CheckOutcome } from "./checks/types";

export function contextFor(attempt: Attempt): CheckContext {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  return { attempt, problem: testProblem, catalog: testCatalogIndex, analysis, metrics: new Map() };
}

export function runCheck(id: string, params: unknown, attempt: Attempt): CheckOutcome {
  const check = CHECKS.get(id);
  if (!check) throw new Error(`unknown check ${id}`);
  return check.run(check.params.parse(params), contextFor(attempt));
}

export function mutated<N extends CommandName>(
  name: N,
  args: CommandArgs<N>,
  base: Attempt = cacheAsideAttempt(),
): Attempt {
  return applyCommand(base, name, args).attempt;
}

/** A redirect scenario shaped like content's S2, kept here so evaluator tests stay self-contained. */
export const redirectScenario: Scenario = ScenarioSchema.parse({
  id: "s2-redirect",
  problemId: "url-shortener",
  title: "Redirect",
  order: 2,
  story: "Visitors click short links.",
  focusOperations: ["redirect"],
  dimensions: { correctness: 0.4, latency: 0.25, scalability: 0.2, availability: 0.15 },
  checks: [
    {
      id: "redirect-reads-link",
      use: "no-path",
      title: "Redirects come from stored data",
      dimension: "correctness",
      gate: true,
      params: {
        operation: "redirect",
        where: {
          all: [
            { statusClass: "3xx" },
            { not: { hasStep: { entity: "Link", outcome: ["hit", "found"] } } },
          ],
        },
      },
      why: "w",
      fix: "f",
    },
    {
      id: "unknown-code-404",
      use: "status-for-condition",
      title: "Unknown codes answer 404",
      dimension: "correctness",
      gate: true,
      params: {
        operation: "redirect",
        when: { hasStep: { action: "store.read", entity: "Link", outcome: "notFound" } },
        statuses: [404],
      },
      why: "w",
      fix: "f",
    },
    {
      id: "errors-handled",
      use: "outcome-handled",
      title: "Errors are handled",
      dimension: "availability",
      weight: 2,
      params: { operation: "redirect", outcome: "error" },
      why: "w",
      fix: "f",
    },
    {
      id: "populate",
      use: "populate-after-miss",
      title: "Cache warms",
      dimension: "latency",
      params: { operation: "redirect", entity: "Link" },
      why: "w",
      fix: "f",
    },
    {
      id: "spof",
      use: "no-single-point-of-failure",
      title: "No single point of failure",
      dimension: "availability",
      weight: 3,
      params: { operation: "redirect" },
      why: "w",
      fix: "f",
    },
    {
      id: "unused",
      use: "unused-components",
      title: "No dead weight",
      dimension: "correctness",
      weight: 0,
      params: {},
      why: "w",
      fix: "f",
    },
    {
      id: "negative-cache",
      use: "all-success-paths-contain",
      title: "Negative caching",
      dimension: "latency",
      signal: "senior",
      params: {
        operation: "redirect",
        statuses: [404],
        step: { action: "cache.setNegative", entity: "Link" },
      },
      why: "w",
      fix: "f",
    },
  ],
});
