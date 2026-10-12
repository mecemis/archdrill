import {
  type Attempt,
  applyCommand,
  type CommandArgs,
  type CommandName,
  WorkloadSchema,
} from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateEnvironment } from "./simulate";

const STORED = 1.58e11;
const OCCUPANCY_7 = STORED / 62 ** 7;

const workload = WorkloadSchema.parse({
  operations: {
    "create-link": {
      entity: "Link",
      classes: [
        { id: "generated", share: 0.97 },
        { id: "custom-free", share: 0.02, customAlias: true },
        { id: "custom-taken", share: 0.01, customAlias: true, aliasTaken: true },
      ],
    },
  },
  keys: { Link: { existing: { distribution: "zipf", s: 1, population: 1e6 } } },
  dataset: { Link: STORED },
  keyspace: { Link: { alphabet: 62, lengthDecision: "code-length" } },
  environments: [{ id: "steady", label: "Steady", rates: { "create-link": 1000 } }],
});

function step<N extends CommandName>(attempt: Attempt, name: N, args: CommandArgs<N>): Attempt {
  return applyCommand(attempt, name, args).attempt;
}

type Generator = "random" | "random-retry" | "kgs";

/** create-link: custom alias? → (generate) → insertIfAbsent → 201 / conflict handling. */
function createFlow(generator: Generator, batchSize?: number): Attempt {
  let a = step(cacheAsideAttempt(), "addComponent", {
    id: "kgs",
    kind: "id-generator",
    flavor: "kgs",
    label: "KGS",
    size: "m",
    replicas: 2,
    position: { x: 0, y: 0 },
  });
  a = step(a, "addConnection", { from: "api", to: "kgs" });
  a = step(a, "createFlow", { operation: "create-link", handler: "api" });
  const add = (
    id: string,
    input: CommandArgs<"addStep">["step"],
    attach: CommandArgs<"addStep">["attach"],
  ) => {
    a = step(a, "addStep", { operation: "create-link", id, step: input, attach });
  };
  const at = (stepId: string, outcome: string) => ({ to: "outcome" as const, stepId, outcome });
  add("alias", { type: "logic", logic: "hasCustomAlias" }, { to: "root" });
  add(
    "insert-alias",
    { type: "call", target: "db", action: "store.insertIfAbsent", entity: "Link" },
    at("alias", "custom"),
  );
  add("r201", { type: "respond", status: 201 }, at("insert-alias", "ok"));
  add("r409", { type: "respond", status: 409 }, at("insert-alias", "conflict"));
  add("r503", { type: "respond", status: 503 }, at("insert-alias", "error"));
  if (generator === "kgs") {
    const kgs = {
      type: "call" as const,
      target: "kgs",
      action: "ids.allocate" as const,
      ...(batchSize ? { batchSize } : {}),
    };
    add("gen", kgs, at("alias", "generated"));
    a = step(a, "linkOutcome", {
      operation: "create-link",
      stepId: "gen",
      outcome: "error",
      target: "r503",
    });
    add(
      "insert",
      { type: "call", target: "db", action: "store.insertIfAbsent", entity: "Link" },
      at("gen", "ok"),
    );
  } else {
    add("gen", { type: "logic", logic: "generateRandomCode" }, at("alias", "generated"));
    add(
      "insert",
      { type: "call", target: "db", action: "store.insertIfAbsent", entity: "Link" },
      at("gen", "ok"),
    );
  }
  for (const [outcome, target] of [
    ["ok", "r201"],
    ["error", "r503"],
  ] as const) {
    a = step(a, "linkOutcome", { operation: "create-link", stepId: "insert", outcome, target });
  }
  if (generator === "random-retry") {
    add("gen2", { type: "logic", logic: "generateRandomCode" }, at("insert", "conflict"));
    add(
      "insert2",
      { type: "call", target: "db", action: "store.insertIfAbsent", entity: "Link" },
      at("gen2", "ok"),
    );
    for (const [outcome, target] of [
      ["ok", "r201"],
      ["conflict", "r503"],
      ["error", "r503"],
    ] as const) {
      a = step(a, "linkOutcome", { operation: "create-link", stepId: "insert2", outcome, target });
    }
  } else {
    a = step(a, "linkOutcome", {
      operation: "create-link",
      stepId: "insert",
      outcome: "conflict",
      target: "r503",
    });
  }
  return a;
}

function simulate(attempt: Attempt) {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  const env = workload.environments[0];
  if (!env) throw new Error("no environment");
  return simulateEnvironment(workload, env, {
    attempt,
    catalog: testCatalogIndex,
    problem: testProblem,
    analysis,
  });
}

/** Share of create requests answered with a given status. */
function statusShare(attempt: Attempt, status: number): number {
  const metrics = simulate(attempt);
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  const paths = analysis.operations.get("create-link")?.paths ?? [];
  return (metrics.operations.get("create-link")?.paths ?? []).reduce((sum, p) => {
    const path = paths.find((x) => x.id === p.pathId);
    return path?.terminal.kind === "respond" && path.terminal.status === status
      ? sum + p.probability
      : sum;
  }, 0);
}

describe("write path simulation", () => {
  it("makes random codes collide as often as the keyspace is full", () => {
    // 503s come from generated collisions only: 97% of requests × occupancy.
    expect(statusShare(createFlow("random"), 503)).toBeCloseTo(0.97 * OCCUPANCY_7, 9);
  });

  it("squares the failure rate with one retry", () => {
    expect(statusShare(createFlow("random-retry"), 503)).toBeCloseTo(0.97 * OCCUPANCY_7 ** 2, 9);
  });

  it("never collides with keys from a generator", () => {
    expect(statusShare(createFlow("kgs"), 503)).toBe(0);
  });

  it("answers 409 exactly for taken aliases", () => {
    expect(statusShare(createFlow("kgs"), 409)).toBeCloseTo(0.01, 12);
  });

  it("lets the code-length decision change the collision rate", () => {
    const longer = applyCommand(createFlow("random"), "setDecision", {
      decision: "code-length",
      option: "8",
    }).attempt;
    expect(statusShare(longer, 503)).toBeCloseTo(0.97 * (STORED / 62 ** 8), 9);
  });

  it("treats an exhausted keyspace as always colliding", () => {
    const tiny = applyCommand(createFlow("random"), "setDecision", {
      decision: "code-length",
      option: "6",
    }).attempt;
    expect(statusShare(tiny, 503)).toBeCloseTo(0.97, 9);
  });

  it("calls the generator once per batch", () => {
    const unbatched = simulate(createFlow("kgs")).components.get("kgs")?.writeLoad ?? 0;
    const batched = simulate(createFlow("kgs", 1000)).components.get("kgs")?.writeLoad ?? 0;

    expect(unbatched).toBeCloseTo(970, 6);
    expect(batched).toBeCloseTo(0.97, 6);
  });
});
