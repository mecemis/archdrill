import { validateScenarioConfig } from "@archdrill/evaluator";
import { describe, expect, it } from "vitest";
import { catalog, loadProblemPack, problemPacks } from "../src/index";

describe("catalog", () => {
  it("gives every flavor with sizes a documented default", () => {
    for (const kind of catalog.kinds) {
      for (const flavor of kind.flavors) {
        if (Object.keys(flavor.sizes).length > 0)
          expect(flavor.defaultSize, flavor.id).toBeDefined();
      }
    }
  });
});

describe.each(problemPacks.map((pack) => [pack.problem.id, pack] as const))(
  "problem %s",
  (_id, pack) => {
    it.each(pack.scenarios.map((s) => [s.id, s] as const))(
      "scenario %s uses known checks with valid parameters",
      (_scenarioId, scenario) => {
        expect(validateScenarioConfig(scenario, pack.problem)).toEqual([]);
      },
    );

    it("lists scenarios in order", () => {
      const orders = pack.scenarios.map((s) => s.order);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    });

    it("gives every scored check an explanation and a fix", () => {
      for (const scenario of pack.scenarios) {
        for (const check of scenario.checks) {
          expect(check.why.length, check.id).toBeGreaterThan(40);
          expect(check.fix.length, check.id).toBeGreaterThan(20);
        }
      }
    });
  },
);

describe("loadProblemPack", () => {
  it("rejects a scenario that belongs to another problem", () => {
    const [pack] = problemPacks;
    if (!pack) throw new Error("no packs");
    const foreign = { ...pack.scenarios[0], problemId: "other" };

    expect(() => loadProblemPack(pack.problem, [foreign])).toThrow(/belongs to "other"/);
  });
});
