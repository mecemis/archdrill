import {
  type Attempt,
  applyCommand,
  type Flow,
  type Step,
  validateAttempt,
} from "@archdrill/model";
import {
  cacheAsideAttempt,
  testCatalogIndex,
  testProblem,
  withNearCache,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { type AnyCommand, createAttemptStore } from "../../state/attempt-store";
import type { EditContext } from "./flow-edits";
import { type Pattern, patternsAt } from "./patterns";
import { type PickerMode, patternCommands } from "./pick";

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

const run = (attempt: Attempt, commands: readonly AnyCommand[]) =>
  commands.reduce((a, c) => applyCommand(a, c.name, c.args as never).attempt, attempt);

/** The cache-aside design with a flow for an operation, made of these steps. */
function withFlow(operation: string, steps: readonly AnyCommand[] = []): Attempt {
  const base = applyCommand(cacheAsideAttempt(), "createFlow", { operation, handler: "api" });
  return run(base.attempt, steps);
}

const add = (operation: string, id: string, step: unknown, attach: unknown): AnyCommand =>
  ({ name: "addStep", args: { operation, id, step, attach } }) as AnyCommand;

const queue: AnyCommand = {
  name: "addComponent",
  args: {
    id: "queue",
    kind: "queue",
    flavor: "managed-queue",
    label: "Link events",
    position: { x: 0, y: 0 },
  },
};

function pattern(ctx: EditContext, mode: PickerMode, key: string): Pattern {
  const found = patternsAt(ctx, mode, "Link").find((p) => p.key === key);
  if (!found) throw new Error(`no pattern ${key}`);
  return found;
}

/** Applies a pattern, and returns the flow it made and the attempt's errors. */
function apply(attempt: Attempt, operation: string, mode: PickerMode, key: string) {
  const ctx = context(attempt, operation);
  const after = run(attempt, patternCommands(ctx, mode, pattern(ctx, mode, key)).commands);
  const issues = validateAttempt(after, { catalog: testCatalogIndex, problem: testProblem });
  return {
    after,
    flow: after.flows.find((f) => f.operation === operation) as Flow,
    errors: issues.filter((i) => i.severity === "error").map((i) => i.message),
  };
}

const call = (flow: Flow, action: string): [string, Step & { type: "call" }][] =>
  Object.entries(flow.steps).filter(
    (entry): entry is [string, Step & { type: "call" }] =>
      entry[1].type === "call" && entry[1].action === action,
  );

const statusOf = (flow: Flow, id: string | undefined) => {
  const step = id === undefined ? undefined : flow.steps[id];
  return step?.type === "respond" ? step.status : null;
};

const root = { kind: "append", at: { kind: "root" } } as const;

describe("patterns", () => {
  it("reads through a cache on a read path, both ways sharing the success response", () => {
    const attempt = run(cacheAsideAttempt(), [
      { name: "removeFlow", args: { operation: "redirect" } },
      { name: "createFlow", args: { operation: "redirect", handler: "api" } },
    ]);
    const { flow, errors } = apply(attempt, "redirect", root, "cache-aside:redis:db");
    const [[getId, get]] = call(flow, "cache.get") as [[string, Step & { type: "call" }]];
    const [[, read]] = call(flow, "store.read") as [[string, Step & { type: "call" }]];
    const [[, save]] = call(flow, "cache.set") as [[string, Step & { type: "call" }]];

    expect(flow.root).toBe(getId);
    expect(get.next.miss).toBe(get.next.error);
    expect(flow.steps[get.next.miss as string]).toBe(read);
    expect(flow.steps[read.next.found as string]).toBe(save);
    expect(statusOf(flow, read.next.notFound)).toBe(404);
    expect(statusOf(flow, read.next.error)).toBe(503);
    // A hit and a filled cache answer with the same response.
    expect(statusOf(flow, get.next.hit)).toBe(301);
    expect(save.next.ok).toBe(get.next.hit);
    expect(save.next.error).toBe(get.next.hit);
    expect(save.ttlSec).toBe(3600);
    expect(errors).toEqual([]);
  });

  it("reads through a shared cache before one inside the service, from the store that holds the data", () => {
    const attempt = run(withNearCache(cacheAsideAttempt()), [
      {
        name: "addComponent",
        args: {
          id: "clicks",
          kind: "wide-column-db",
          flavor: "cassandra",
          label: "Click stats",
          position: { x: 0, y: 0 },
        },
      },
      { name: "addConnection", args: { from: "api", to: "clicks" } },
    ]);
    const ctx = context(attempt, "redirect");
    const mode = { kind: "insert", at: { kind: "root" }, before: ctx.flow.root ?? "" } as const;

    expect(patternsAt(ctx, mode, "Link").map((p) => p.key)).toEqual([
      "cache-aside:redis:db",
      "cache-aside:near:db",
    ]);
  });

  it("goes in front of a step as a whole: every way out leads into it", () => {
    const attempt = withFlow("create-link", [
      add("create-link", "validate", { type: "logic", logic: "validateUrl" }, { to: "root" }),
      add(
        "create-link",
        "r201",
        { type: "respond", status: 201 },
        { to: "outcome", stepId: "validate", outcome: "valid" },
      ),
    ]);
    const mode = {
      kind: "insert",
      at: { kind: "after", stepId: "validate", outcomes: ["valid"] },
      before: "r201",
    } as const;
    const { flow, errors } = apply(attempt, "create-link", mode, "retry:db:random");
    const inserts = call(flow, "store.insertIfAbsent").map(([, s]) => s);
    const generated = Object.entries(flow.steps).filter(
      ([, s]) => s.type === "logic" && s.logic === "generateRandomCode",
    );

    expect(flow.steps.validate?.type === "logic" && flow.steps.validate.next.valid).toBe(
      generated[0]?.[0],
    );
    expect(generated).toHaveLength(2);
    expect(inserts).toHaveLength(2);
    expect(inserts.map((s) => s.next.ok)).toEqual(["r201", "r201"]);
    // The first conflict draws a new code; the second one gives up.
    expect(flow.steps[inserts[0]?.next.conflict as string]).toBe(generated[1]?.[1]);
    expect(statusOf(flow, inserts[1]?.next.conflict)).toBe(503);
    expect(errors).toEqual([]);
  });

  it("uses the key the step before made, and generates only the second one", () => {
    const attempt = withFlow("create-link", [
      add("create-link", "code", { type: "logic", logic: "generateRandomCode" }, { to: "root" }),
    ]);
    const ctx = context(attempt, "create-link");
    const mode = {
      kind: "append",
      at: { kind: "after", stepId: "code", outcomes: ["ok"] },
    } as const;
    const retry = pattern(ctx, mode, "retry:db:random");

    expect(retry.label).toBe(
      "Write Link to Postgres if its key is free; on a conflict, generate random code and try once more",
    );
    expect(retry.steps.map((s) => s.key)).toEqual(["insert", "again", "retry"]);
  });

  it("offers no retry right behind a conditional insert", () => {
    const attempt = withFlow("create-link", [
      add(
        "create-link",
        "insert",
        { type: "call", target: "db", action: "store.insertIfAbsent", entity: "Link" },
        { to: "root" },
      ),
    ]);
    const ctx = context(attempt, "create-link");
    const mode = {
      kind: "append",
      at: { kind: "after", stepId: "insert", outcomes: ["ok"] },
    } as const;

    expect(patternsAt(ctx, mode, "Link").filter((p) => p.name === "Insert with a retry")).toEqual(
      [],
    );
  });

  it("publishes through an outbox right after a committed write, and leaves the way on open", () => {
    const attempt = run(
      withFlow("create-link", [
        add(
          "create-link",
          "write",
          { type: "call", target: "db", action: "store.insert", entity: "Link" },
          { to: "root" },
        ),
      ]),
      [queue],
    );
    const ctx = context(attempt, "create-link");
    const behindWrite = (outcomes: string[]) =>
      ({ kind: "append", at: { kind: "after", stepId: "write", outcomes } }) as const;

    const outboxes = (outcomes: string[]) =>
      patternsAt(ctx, behindWrite(outcomes), "Link").filter(
        (p) => p.name === "Publish through an outbox",
      );

    expect(outboxes(["error"])).toEqual([]);
    // The event that names what the operation does, not every event about a link.
    expect(outboxes(["ok"]).map((p) => p.key)).toEqual(["outbox:queue:link-created"]);
    const {
      flow,
      after: design,
      errors,
    } = apply(attempt, "create-link", behindWrite(["ok"]), "outbox:queue:link-created");
    const [[publishId, publish]] = call(flow, "queue.publish") as [
      [string, Step & { type: "call" }],
    ];

    expect(flow.steps.write?.type === "call" && flow.steps.write.next.ok).toBe(publishId);
    expect(publish.outbox).toBe(true);
    expect(publish.next).toEqual({});
    expect(design.architecture.connections.map((c) => c.id)).toContain("api--queue");
    expect(errors).toEqual([]);
  });

  it("publishes to the queue the event's consumers take it from", () => {
    const attempt = run(
      withFlow("create-link", [
        add(
          "create-link",
          "write",
          { type: "call", target: "db", action: "store.insert", entity: "Link" },
          { to: "root" },
        ),
      ]),
      [
        queue,
        {
          name: "addComponent",
          args: {
            id: "clicks",
            kind: "queue",
            flavor: "managed-queue",
            label: "Clicks",
            position: { x: 0, y: 0 },
          },
        },
        // The link scanner consumes link-created from Link events.
        { name: "addConnection", args: { from: "queue", to: "api" } },
        { name: "createFlow", args: { operation: "scan-link", handler: "api" } },
      ],
    );
    const ctx = context(attempt, "create-link");
    const mode = {
      kind: "append",
      at: { kind: "after", stepId: "write", outcomes: ["ok"] },
    } as const;

    expect(
      patternsAt(ctx, mode, "Link")
        .filter((p) => p.name === "Publish through an outbox")
        .map((p) => p.key),
    ).toEqual(["outbox:queue:link-created"]);
  });

  it("offers an outbox only behind a store with transactions", () => {
    const attempt = run(
      withFlow("create-link", [
        add(
          "create-link",
          "write",
          { type: "call", target: "ddb", action: "store.insert", entity: "Link" },
          { to: "root" },
        ),
      ]),
      [
        queue,
        {
          name: "addComponent",
          args: {
            id: "ddb",
            kind: "key-value-db",
            flavor: "dynamodb",
            label: "DynamoDB",
            position: { x: 0, y: 0 },
          },
        },
      ],
    );
    const ctx = context(attempt, "create-link");
    const mode = {
      kind: "append",
      at: { kind: "after", stepId: "write", outcomes: ["ok"] },
    } as const;

    expect(patternsAt(ctx, mode, "Link").filter((p) => p.key.startsWith("outbox"))).toEqual([]);
  });

  it("offers only what fits the operation", () => {
    const write = context(withFlow("create-link"), "create-link");
    const read = context(cacheAsideAttempt(), "redirect");
    const job = context(withFlow("purge-expired"), "purge-expired");
    const kinds = (ctx: EditContext) => [
      ...new Set(patternsAt(ctx, root, "Link").map((p) => p.name)),
    ];

    expect(kinds(read)).toEqual(["Cache-aside"]);
    expect(kinds(write)).toEqual(["Insert with a retry"]);
    expect(kinds(job)).toEqual([]);
  });

  it("is one change, undone at once", () => {
    const attempt = run(cacheAsideAttempt(), [
      { name: "removeFlow", args: { operation: "redirect" } },
      { name: "createFlow", args: { operation: "redirect", handler: "api" } },
    ]);
    const ctx = context(attempt, "redirect");
    const store = createAttemptStore(attempt);
    const { commands } = patternCommands(ctx, root, pattern(ctx, root, "cache-aside:redis:db"));

    expect(store.getState().dispatchAll(commands)).toBe(true);
    store.getState().undo();
    expect(store.getState().attempt).toEqual(attempt);
  });
});
