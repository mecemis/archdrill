import { applyCommand, type Scenario } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { guideFor } from "./guide";

const scenario = {
  id: "s2",
  order: 2,
  title: "Redirect",
  focusOperations: ["redirect"],
} as unknown as Scenario;
const waiting = {
  scenarioId: "s2",
  status: "incomplete",
  operations: [{ operation: "redirect", status: "missing" }],
} as const;

const doneSteps = (
  attempt: Parameters<typeof guideFor>[0],
  result: Parameters<typeof guideFor>[3],
) =>
  guideFor(attempt, scenario, testProblem.operations, result, testCatalogIndex)
    .steps.filter((s) => s.done)
    .map((s) => s.id);

describe("guideFor", () => {
  it("starts an empty design at adding a service", () => {
    const empty = {
      ...cacheAsideAttempt(),
      architecture: { components: [], connections: [] },
      flows: [],
    };
    const guide = guideFor(empty, scenario, testProblem.operations, waiting, testCatalogIndex);

    expect(guide.current).toBe("service");
    expect(guide.operation?.id).toBe("redirect");
  });

  it("ticks off the topology, then asks for the flow", () => {
    const attempt = { ...cacheAsideAttempt(), flows: [] };

    expect(doneSteps(attempt, waiting)).toEqual(["service", "connect"]);
  });

  it("asks for every branch to be answered", () => {
    const attempt = applyCommand(cacheAsideAttempt(), "linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "error",
      target: null,
    }).attempt;
    const guide = guideFor(attempt, scenario, testProblem.operations, waiting, testCatalogIndex);

    expect(guide.current).toBe("branches");
  });

  it("is done once the scenario is evaluated", () => {
    const evaluated = { scenarioId: "s2", status: "evaluated" } as unknown as Parameters<
      typeof guideFor
    >[3];
    const guide = guideFor(
      cacheAsideAttempt(),
      scenario,
      testProblem.operations,
      evaluated,
      testCatalogIndex,
    );

    expect(guide.current).toBeNull();
  });
});
