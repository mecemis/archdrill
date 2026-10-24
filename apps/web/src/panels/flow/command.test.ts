import { type Attempt, applyCommand, type Flow } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { choicesAt, matching } from "./command";
import type { EditContext } from "./flow-edits";

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

/** The cache-aside design with its redirect flow emptied. */
function emptyRedirect(): EditContext {
  let attempt = applyCommand(cacheAsideAttempt(), "removeFlow", { operation: "redirect" }).attempt;
  attempt = applyCommand(attempt, "createFlow", { operation: "redirect", handler: "api" }).attempt;
  return context(attempt, "redirect");
}

const root = { kind: "append", at: { kind: "root" } } as const;
const facts = new Set<string>();

describe("choicesAt", () => {
  it("lists what the picker lists, in its order: likely next, patterns, calls, decisions", () => {
    const groups = [
      ...new Set(choicesAt(emptyRedirect(), root, "Link", facts).map((c) => c.group)),
    ];

    expect(groups).toEqual(["Likely next", "Pattern", "Redis", "Postgres", "Decide"]);
  });

  it("lists a step once, where it first appears", () => {
    const choices = choicesAt(emptyRedirect(), root, "Link", facts);
    const steps = choices.flatMap((c) =>
      c.add.kind === "step" ? [JSON.stringify(c.add.step)] : [],
    );

    expect(new Set(steps).size).toBe(steps.length);
  });

  it("offers responses behind a step, the likely ones among the likely next steps", () => {
    const ctx = context(cacheAsideAttempt(), "redirect");
    const behind = {
      kind: "append",
      at: { kind: "after", stepId: "read", outcomes: ["found"] },
    } as const;
    const choices = choicesAt(ctx, behind, "Link", facts);
    const group = (label: string) => choices.find((c) => c.label === label)?.group;

    expect(group("Respond 302 Found")).toBe("Likely next");
    expect(group("Respond 503 Service Unavailable")).toBe("Respond");
  });
});

describe("matching", () => {
  const choices = choicesAt(emptyRedirect(), root, "Link", facts);

  it("keeps the choices that hold every word typed, in any order and case", () => {
    expect(matching(choices, "postgres READ")[0]?.label).toBe("Read Link from Postgres");
  });

  it("matches what a choice is, too", () => {
    expect(matching(choices, "pattern").map((c) => c.group)).toEqual(["Pattern"]);
  });

  it("keeps every choice while nothing is typed", () => {
    expect(matching(choices, "  ")).toEqual(choices);
  });
});
