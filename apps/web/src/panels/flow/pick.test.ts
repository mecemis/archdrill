import { type Attempt, applyCommand, type Flow, findOperationRoute } from "@archdrill/model";
import {
  asyncAttempt,
  cacheAsideAttempt,
  testCatalogIndex,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { createAttemptStore } from "../../state/attempt-store";
import type { EditContext } from "./flow-edits";
import { chosenStepCommands } from "./pick";

function context(attempt: Attempt, operationId: string): EditContext {
  const operation = testProblem.operations.find((o) => o.id === operationId);
  if (!operation) throw new Error(operationId);
  return {
    flow: attempt.flows.find((f) => f.operation === operationId) as Flow,
    attempt,
    problem: testProblem,
    operation,
    catalog: testCatalogIndex,
    background: operation.trigger.type !== "request",
  };
}

const publish = {
  type: "call" as const,
  target: "queue",
  action: "queue.publish" as const,
  event: "link-created",
};

/** In front of the flow's first step. */
const first = (ctx: EditContext) =>
  ({ kind: "insert", at: { kind: "root" }, before: ctx.flow.root ?? "" }) as const;

describe("chosenStepCommands", () => {
  it("connects the service to a component it calls for the first time, as one undoable change", () => {
    const attempt = applyCommand(cacheAsideAttempt(), "addComponent", {
      id: "queue",
      kind: "queue",
      flavor: "managed-queue",
      label: "Link events",
      position: { x: 0, y: 0 },
    }).attempt;
    const ctx = context(attempt, "redirect");
    const { commands, connects } = chosenStepCommands(ctx, first(ctx), publish);
    const store = createAttemptStore(attempt);

    expect(connects).toBe(true);
    expect(commands[0]).toEqual({ name: "addConnection", args: { from: "api", to: "queue" } });
    expect(store.getState().dispatchAll(commands)).toBe(true);
    expect(store.getState().attempt.architecture.connections.map((c) => c.id)).toContain(
      "api--queue",
    );
    store.getState().undo();
    expect(store.getState().attempt).toEqual(attempt);
  });

  it("turns round a consumer's own queue rather than connecting it twice", () => {
    const delivered = applyCommand(asyncAttempt(), "reverseConnection", {
      id: "worker--queue",
    }).attempt;
    const ctx = context(delivered, "scan-link");
    const { commands } = chosenStepCommands(ctx, first(ctx), publish);
    const after = commands.reduce(
      (a, c) => applyCommand(a, c.name, c.args as never).attempt,
      delivered,
    );
    const scan = testProblem.operations.find((o) => o.id === "scan-link");

    expect(commands[0]).toEqual({ name: "reverseConnection", args: { id: "queue--worker" } });
    expect(
      after.architecture.connections.filter(
        (c) => [c.from, c.to].includes("worker") && [c.from, c.to].includes("queue"),
      ),
    ).toHaveLength(1);
    // The consumer still receives its messages over the turned connection.
    expect(scan && findOperationRoute(scan, after, testCatalogIndex, "worker")).not.toBeNull();
  });

  it("adds only the step over an existing connection", () => {
    const ctx = context(asyncAttempt(), "create-link");
    const { commands, connects } = chosenStepCommands(ctx, first(ctx), publish);

    expect(connects).toBe(false);
    expect(commands.some((c) => c.name === "addConnection")).toBe(false);
  });
});
