import type { RequestClass } from "@archdrill/model";
import { describe, expect, it } from "vitest";
import type { CallPathStep, LogicPathStep, Path, PathStep } from "../paths/types";
import type { OutcomeState } from "./outcomes";
import { pathProbabilities } from "./summary";

const state: OutcomeState = {
  callFailure: (step) => (step.target === "kgs" ? 0.1 : 0),
  hitRatio: () => 0,
  negativeHitRatio: () => 0,
  occupancy: () => 0.05,
  aliasOccupancy: () => 0.001,
  exists: (_entity, cls) => cls.exists,
};

const generated: RequestClass = {
  id: "generated",
  share: 1,
  exists: true,
  expired: false,
  disabled: false,
  invalidInput: false,
  customAlias: false,
  aliasTaken: false,
  hotKey: false,
  malicious: false,
  facts: [],
  counts: {},
};

const alias = (outcome: string): LogicPathStep => ({
  kind: "logic",
  stepId: "alias",
  logic: "hasCustomAlias",
  outcome,
});

const call = (action: "ids.allocate" | "store.insertIfAbsent", outcome: string): CallPathStep => ({
  kind: "call",
  stepId: action,
  target: action === "ids.allocate" ? "kgs" : "db",
  targetKind: action === "ids.allocate" ? "id-generator" : "relational-db",
  connectionId: null,
  action,
  entity: action === "ids.allocate" ? undefined : "Link",
  ttlSec: undefined,
  batchSize: undefined,
  event: undefined,
  outcome,
});

const path = (index: number, steps: readonly PathStep[]): Path => ({
  id: `create-link#${index}`,
  operation: "create-link",
  index,
  steps,
  terminal: { kind: "respond", stepId: "done", status: 201 },
  components: [],
  connections: [],
});

describe("pathProbabilities", () => {
  it("gives every path what it gets on its own, sharing prefixes as a depth-first walk does", () => {
    // Step objects are shared between paths that start the same way.
    const custom = alias("custom");
    const generatedCode = alias("generated");
    const allocated = call("ids.allocate", "ok");
    const paths = [
      path(0, [custom, call("store.insertIfAbsent", "ok")]),
      path(1, [custom, call("store.insertIfAbsent", "conflict")]),
      path(2, [generatedCode, allocated, call("store.insertIfAbsent", "ok")]),
      path(3, [generatedCode, allocated, call("store.insertIfAbsent", "conflict")]),
      path(4, [generatedCode, call("ids.allocate", "error")]),
    ];

    const together = pathProbabilities(paths, generated, state);

    for (const [index, single] of paths.entries()) {
      expect(together[index]).toBe(pathProbabilities([single], generated, state)[0]);
    }
    // A generated code never takes the custom-alias branch.
    expect(together[0]).toBe(0);
    expect(together[1]).toBe(0);
    expect(together[4]).toBeCloseTo(0.1, 12);
    expect((together[2] ?? 0) + (together[3] ?? 0) + (together[4] ?? 0)).toBeCloseTo(1, 12);
  });
});
