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
import chatProblem from "../problems/chat/problem.yaml";
import chatS1 from "../problems/chat/scenarios/s1-deliver.yaml";
import chatS2 from "../problems/chat/scenarios/s2-groups.yaml";
import chatS3 from "../problems/chat/scenarios/s3-presence.yaml";
import newsFeedProblem from "../problems/news-feed/problem.yaml";
import newsFeedS1 from "../problems/news-feed/scenarios/s1-timeline.yaml";
import newsFeedS2 from "../problems/news-feed/scenarios/s2-celebrities.yaml";
import newsFeedS3 from "../problems/news-feed/scenarios/s3-timelines-lost.yaml";
import rateLimiterProblem from "../problems/rate-limiter/problem.yaml";
import rateLimiterS1 from "../problems/rate-limiter/scenarios/s1-enforce.yaml";
import rateLimiterS2 from "../problems/rate-limiter/scenarios/s2-limiter-down.yaml";
import rateLimiterS3 from "../problems/rate-limiter/scenarios/s3-rogue-client.yaml";
import urlShortenerProblem from "../problems/url-shortener/problem.yaml";
import urlShortenerS1 from "../problems/url-shortener/scenarios/s1-create.yaml";
import urlShortenerS2 from "../problems/url-shortener/scenarios/s2-redirect.yaml";
import urlShortenerS3 from "../problems/url-shortener/scenarios/s3-cache.yaml";
import urlShortenerS4 from "../problems/url-shortener/scenarios/s4-cache-outage.yaml";
import urlShortenerS5 from "../problems/url-shortener/scenarios/s5-hot-keys.yaml";
import urlShortenerS6 from "../problems/url-shortener/scenarios/s6-dependency-failure.yaml";
import urlShortenerS7 from "../problems/url-shortener/scenarios/s7-edge-cases.yaml";
import urlShortenerS8 from "../problems/url-shortener/scenarios/s8-click-analytics.yaml";

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
  loadProblemPack(urlShortenerProblem, [
    urlShortenerS1,
    urlShortenerS2,
    urlShortenerS3,
    urlShortenerS4,
    urlShortenerS5,
    urlShortenerS6,
    urlShortenerS7,
    urlShortenerS8,
  ]),
  loadProblemPack(rateLimiterProblem, [rateLimiterS1, rateLimiterS2, rateLimiterS3]),
  loadProblemPack(newsFeedProblem, [newsFeedS1, newsFeedS2, newsFeedS3]),
  loadProblemPack(chatProblem, [chatS1, chatS2, chatS3]),
];

export function getProblemPack(problemId: string): ProblemPack | undefined {
  return problemPacks.find((pack) => pack.problem.id === problemId);
}
