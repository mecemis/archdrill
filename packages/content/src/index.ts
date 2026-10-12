/// <reference path="./yaml.d.ts" />
import {
  type Catalog,
  CatalogSchema,
  createCatalogIndex,
  type Problem,
  ProblemSchema,
  type Scenario,
  ScenarioSchema,
} from "@archdrill/model";
import type { z } from "zod";
import catalogData from "../catalog/catalog.yaml";
import urlShortenerProblem from "../problems/url-shortener/problem.yaml";
import urlShortenerS2 from "../problems/url-shortener/scenarios/s2-redirect.yaml";
import urlShortenerS3 from "../problems/url-shortener/scenarios/s3-cache.yaml";

export interface ProblemPack {
  readonly problem: Problem;
  /** Scenarios in the order the problem lists them. */
  readonly scenarios: readonly Scenario[];
}

export class ContentError extends Error {
  override readonly name = "ContentError";
}

function parse<S extends z.ZodType>(schema: S, data: unknown, source: string): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ContentError(`Invalid content in ${source}:\n${result.error.message}`);
  }
  return result.data;
}

export function loadProblemPack(
  problemData: unknown,
  scenarioData: readonly unknown[],
): ProblemPack {
  const problem = parse(ProblemSchema, problemData, "problem");
  const byId = new Map<string, Scenario>();
  for (const data of scenarioData) {
    const scenario = parse(ScenarioSchema, data, `${problem.id} scenario`);
    if (scenario.problemId !== problem.id) {
      throw new ContentError(
        `Scenario "${scenario.id}" belongs to "${scenario.problemId}", not "${problem.id}".`,
      );
    }
    for (const op of scenario.focusOperations) {
      if (!problem.operations.some((o) => o.id === op)) {
        throw new ContentError(`Scenario "${scenario.id}" focuses on unknown operation "${op}".`);
      }
    }
    byId.set(scenario.id, scenario);
  }
  const scenarios = problem.scenarios.map((id) => {
    const scenario = byId.get(id);
    if (!scenario)
      throw new ContentError(`Problem "${problem.id}" lists missing scenario "${id}".`);
    return scenario;
  });
  if (byId.size !== scenarios.length) {
    throw new ContentError(`Problem "${problem.id}" has scenarios it does not list.`);
  }
  return { problem, scenarios };
}

export const catalog: Catalog = parse(CatalogSchema, catalogData, "catalog.yaml");
export const catalogIndex = createCatalogIndex(catalog);

export const problemPacks: readonly ProblemPack[] = [
  loadProblemPack(urlShortenerProblem, [urlShortenerS2, urlShortenerS3]),
];

export function getProblemPack(problemId: string): ProblemPack | undefined {
  return problemPacks.find((pack) => pack.problem.id === problemId);
}
