import type { Attempt } from "../attempt/schema";
import { applyCommand, type CommandArgs, type CommandName } from "../commands/index";
import { cacheAsideAttempt } from "./fixtures";

function step<N extends CommandName>(attempt: Attempt, name: N, args: CommandArgs<N>): Attempt {
  return applyCommand(attempt, name, args).attempt;
}

export type Generator = "random" | "random-retry" | "kgs";

/** create-link: custom alias? → (generate) → insertIfAbsent → 201 / conflict handling. */
export function createLinkAttempt(generator: Generator, batchSize?: number): Attempt {
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
