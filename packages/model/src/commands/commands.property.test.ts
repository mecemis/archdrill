import fc from "fast-check";
import { applyPatches, type Patch } from "immer";
import { describe, expect, it } from "vitest";
import type { Attempt } from "../attempt/schema";
import { AttemptSchema } from "../attempt/schema";
import { cacheAsideAttempt } from "../testing/fixtures";
import { applyCommand, type CommandArgs, type CommandName } from "./index";

type AnyCommand = { [N in CommandName]: { name: N; args: CommandArgs<N> } }[CommandName];

const componentIds = ["client", "lb", "api", "redis", "db", "extra"];
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
const outcomes = [
  "hit",
  "miss",
  "error",
  "found",
  "notFound",
  "valid",
  "expired",
  "ok",
  "negativeHit",
];

/** Commands over a small id space so many of them hit existing things (and some fail). */
const commandArb: fc.Arbitrary<AnyCommand> = fc.oneof(
  fc.record({
    name: fc.constant("addComponent" as const),
    args: fc.record({
      id: fc.constantFrom("extra", "extra-2"),
      kind: fc.constant("cache"),
      flavor: fc.constant("redis"),
      label: fc.constant("Extra"),
      position: fc.record({
        x: fc.integer({ min: -500, max: 500 }),
        y: fc.integer({ min: -500, max: 500 }),
      }),
    }),
  }),
  fc.record({
    name: fc.constant("removeComponent" as const),
    args: fc.record({ id: fc.constantFrom(...componentIds) }),
  }),
  fc.record({
    name: fc.constant("updateComponent" as const),
    args: fc.record({
      id: fc.constantFrom(...componentIds),
      replicas: fc.integer({ min: 1, max: 9 }),
    }),
  }),
  fc.record({
    name: fc.constant("addConnection" as const),
    args: fc.record({
      from: fc.constantFrom(...componentIds),
      to: fc.constantFrom(...componentIds),
    }),
  }),
  fc.record({
    name: fc.constant("reverseConnection" as const),
    args: fc.record({ id: fc.constantFrom("client--lb", "lb--api", "api--redis", "api--db") }),
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
    name: fc.constant("linkOutcome" as const),
    args: fc.record({
      operation: fc.constant("redirect"),
      stepId: fc.constantFrom(...stepIds),
      outcome: fc.constantFrom(...outcomes),
      target: fc.option(fc.constantFrom(...stepIds), { nil: null }),
    }),
  }),
);

function run(base: Attempt, commands: readonly AnyCommand[]) {
  let attempt = base;
  const undo: Patch[][] = [];
  for (const command of commands) {
    try {
      const result = applyCommand(attempt, command.name, command.args as never);
      attempt = result.attempt;
      undo.push(result.inversePatches);
    } catch {
      // Rejected commands must leave the attempt untouched; nothing to record.
    }
  }
  return { attempt, undo };
}

describe("command properties", () => {
  it("undoing every applied command restores the original attempt", () => {
    fc.assert(
      fc.property(fc.array(commandArb, { maxLength: 25 }), (commands) => {
        const base = cacheAsideAttempt();
        const { attempt, undo } = run(base, commands);
        const restored = undo.reduceRight(
          (current, patches) => applyPatches(current, patches),
          attempt,
        );
        expect(restored).toEqual(base);
      }),
      { numRuns: 300 },
    );
  });

  it("every reachable attempt still satisfies the schema", () => {
    fc.assert(
      fc.property(fc.array(commandArb, { maxLength: 25 }), (commands) => {
        const { attempt } = run(cacheAsideAttempt(), commands);
        expect(AttemptSchema.safeParse(attempt).success).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
