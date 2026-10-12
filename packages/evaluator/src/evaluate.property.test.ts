import { type Attempt, applyCommand, type CommandArgs, type CommandName } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateAttempt } from "./evaluate";
import { GATE_SCORE_CAP } from "./score";
import { redirectScenario } from "./test-support";

type AnyCommand = { [N in CommandName]: { name: N; args: CommandArgs<N> } }[CommandName];

const stepIds = [
  "get",
  "expiryHit",
  "read",
  "expiryDb",
  "populate",
  "r302",
  "r404",
  "r410",
  "r503",
];

/** Mutations of the redirect flow and topology: the shapes mistakes take. */
const mutationArb: fc.Arbitrary<AnyCommand> = fc.oneof(
  fc.record({
    name: fc.constant("linkOutcome" as const),
    args: fc.record({
      operation: fc.constant("redirect"),
      stepId: fc.constantFrom(...stepIds),
      outcome: fc.constantFrom(
        "hit",
        "miss",
        "error",
        "found",
        "notFound",
        "valid",
        "expired",
        "ok",
      ),
      target: fc.option(fc.constantFrom(...stepIds), { nil: null }),
    }),
  }),
  fc.record({
    name: fc.constant("removeStep" as const),
    args: fc.record({
      operation: fc.constant("redirect"),
      stepId: fc.constantFrom(...stepIds),
      prune: fc.boolean(),
    }),
  }),
  fc.record({
    name: fc.constant("updateComponent" as const),
    args: fc.record({
      id: fc.constantFrom("api", "redis", "db"),
      replicas: fc.integer({ min: 1, max: 4 }),
    }),
  }),
);

function mutate(commands: readonly AnyCommand[]): Attempt {
  return commands.reduce((attempt, command) => {
    try {
      return applyCommand(attempt, command.name, command.args as never).attempt;
    } catch {
      return attempt;
    }
  }, cacheAsideAttempt());
}

const input = { problem: testProblem, scenarios: [redirectScenario], catalog: testCatalogIndex };

describe("evaluation properties", () => {
  it("keeps scores within bounds and caps any design that fails a gate", () => {
    fc.assert(
      fc.property(fc.array(mutationArb, { maxLength: 8 }), (commands) => {
        const [result] = evaluateAttempt(mutate(commands), input).scenarios;
        if (result?.status !== "evaluated") return;
        const { score, band, gateFailures } = result.scorecard;
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
        if (gateFailures.length > 0) {
          expect(score).toBeLessThanOrEqual(GATE_SCORE_CAP);
          expect(band).toBe("not-passing");
        }
      }),
      { numRuns: 300 },
    );
  });

  it("is deterministic for any design", () => {
    fc.assert(
      fc.property(fc.array(mutationArb, { maxLength: 8 }), (commands) => {
        const attempt = mutate(commands);
        expect(evaluateAttempt(attempt, input).scenarios).toEqual(
          evaluateAttempt(attempt, input).scenarios,
        );
      }),
      { numRuns: 100 },
    );
  });

  it("never rewards adding a component that no flow uses", () => {
    fc.assert(
      fc.property(fc.array(mutationArb, { maxLength: 8 }), (commands) => {
        const attempt = mutate(commands);
        const withExtra = applyCommand(attempt, "addComponent", {
          id: "unused",
          kind: "cache",
          flavor: "redis",
          label: "Unused",
          position: { x: 0, y: 0 },
        }).attempt;
        const [before] = evaluateAttempt(attempt, input).scenarios;
        const [after] = evaluateAttempt(withExtra, input).scenarios;
        if (before?.status !== "evaluated" || after?.status !== "evaluated") return;
        expect(after.scorecard.score).toBeLessThanOrEqual(before.scorecard.score);
      }),
      { numRuns: 200 },
    );
  });
});
