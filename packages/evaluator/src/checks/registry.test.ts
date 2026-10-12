import { ScenarioSchema } from "@archdrill/model";
import { testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { validateScenarioConfig } from "./registry";

function scenarioWithKeyspace(lengthDecision: string, dataset: Record<string, number>) {
  return ScenarioSchema.parse({
    id: "create",
    problemId: "url-shortener",
    title: "Create",
    order: 1,
    story: "Links are created.",
    focusOperations: ["create-link"],
    dimensions: { correctness: 1 },
    workload: {
      operations: { "create-link": { entity: "Link", classes: [{ id: "all", share: 1 }] } },
      keys: { Link: { existing: { distribution: "zipf", s: 1, population: 1e6 } } },
      dataset,
      keyspace: { Link: { alphabet: 62, lengthDecision } },
      environments: [{ id: "peak", label: "Peak", rates: { "create-link": 1000, redirect: 5 } }],
    },
    checks: [
      {
        id: "dead-weight",
        use: "unused-components",
        title: "No dead weight",
        dimension: "correctness",
        params: {},
        why: "w",
        fix: "f",
      },
    ],
  });
}

describe("validateScenarioConfig workloads", () => {
  it("accepts a keyspace sized by a numeric decision with a default", () => {
    expect(
      validateScenarioConfig(scenarioWithKeyspace("code-length", { Link: 1e9 }), testProblem),
    ).toEqual([
      {
        checkId: "workload",
        message: 'environment "peak" sets a rate for "redirect", which has no workload',
      },
    ]);
  });

  it("rejects keyspaces the simulator would silently ignore", () => {
    const messages = (lengthDecision: string, dataset: Record<string, number>) =>
      validateScenarioConfig(scenarioWithKeyspace(lengthDecision, dataset), testProblem).map(
        (i) => i.message,
      );

    expect(messages("code-lenght", { Link: 1e9 })).toContain(
      'keyspace for Link uses unknown decision "code-lenght"',
    );
    expect(messages("redirect-status", {})).toEqual(
      expect.arrayContaining([
        "keyspace for Link needs a dataset size",
        'decision "redirect-status" needs a default code length',
        'decision "redirect-status" has options that are not code lengths: s301, s302',
      ]),
    );
  });
});
