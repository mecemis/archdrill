import { type Attempt, applyCommand } from "@archdrill/model";
import { cacheAsideAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { type StudioRow, stepReach, studioColumns, studioRows } from "./rows";

const redirectRows = (attempt: Attempt) =>
  studioRows(attempt.flows.find((f) => f.operation === "redirect") as never, attempt);

/** A row as text: what it is, indented by its frame depth. */
function outline(rows: readonly StudioRow[]): string[] {
  return rows.map((row) => {
    const indent = "  ".repeat(row.depth);
    switch (row.kind) {
      case "step":
        return `${indent}${row.item.number} ${row.item.stepId}`;
      case "frame":
        return `${indent}if ${row.outcome}`;
      case "respond":
        return `${indent}respond ${row.status}`;
      case "goto":
        return `${indent}carry on at ${row.number}`;
      case "gap":
        return `${indent}+${row.end ? " end" : ""}`;
      default:
        return "";
    }
  });
}

describe("studioRows", () => {
  it("lays a flow out as its main path, with branches in frames and a place before every step", () => {
    expect(outline(redirectRows(cacheAsideAttempt()))).toEqual([
      "+",
      "1 get",
      "  if hit",
      "  +",
      "  2 expiryHit",
      "  +",
      "  respond 302",
      "+",
      "3 read",
      "+",
      "4 expiryDb",
      "+",
      "5 populate",
      "+",
      "respond 302",
    ]);
  });

  it("goes in front of a step behind the outcomes that lead to it", () => {
    const gap = redirectRows(cacheAsideAttempt()).find((r) => r.key === "root|gap:before:read");

    expect(gap).toMatchObject({
      mode: {
        kind: "insert",
        at: { kind: "after", stepId: "get", outcomes: ["miss", "error"] },
        before: "read",
      },
    });
  });

  it("ends a list that leads nowhere with a place for a response too", () => {
    const open = applyCommand(cacheAsideAttempt(), "linkOutcome", {
      operation: "redirect",
      stepId: "populate",
      outcome: "ok",
      target: null,
    }).attempt;
    const last = redirectRows(open).at(-1);

    expect(last).toMatchObject({
      kind: "gap",
      end: true,
      mode: { kind: "append", at: { kind: "after", stepId: "populate", outcomes: ["ok"] } },
    });
  });

  it("keys every row uniquely, branch by branch", () => {
    const keys = redirectRows(cacheAsideAttempt()).map((r) => r.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("starts an empty flow with one place", () => {
    const empty = applyCommand(
      applyCommand(cacheAsideAttempt(), "removeFlow", { operation: "redirect" }).attempt,
      "createFlow",
      { operation: "redirect", handler: "api" },
    ).attempt;

    expect(outline(redirectRows(empty))).toEqual(["+ end"]);
  });
});

describe("studioColumns", () => {
  it("puts what the handler calls in the order it first calls it, then the extra ones", () => {
    const rows = redirectRows(cacheAsideAttempt());

    expect(studioColumns(rows)).toEqual(["redis", "db"]);
    expect(studioColumns(rows, ["queue", "db"])).toEqual(["redis", "db", "queue"]);
  });
});

describe("stepReach", () => {
  it("adds up the simulated share of requests on every path through a step", () => {
    const analysis = {
      paths: [
        { id: "p1", steps: [{ stepId: "a" }, { stepId: "b" }, { stepId: "a" }] },
        { id: "p2", steps: [{ stepId: "a" }, { stepId: "c" }] },
      ],
    };
    const metrics = {
      paths: [
        { pathId: "p1", probability: 0.7 },
        { pathId: "p2", probability: 0.3 },
      ],
    };

    const reach = stepReach(analysis as never, metrics as never);

    // A step a path visits twice still counts its requests once.
    expect(reach.get("a")).toBeCloseTo(1, 9);
    expect(reach.get("b")).toBeCloseTo(0.7, 9);
    expect(reach.get("c")).toBeCloseTo(0.3, 9);
    expect(stepReach(undefined, undefined).size).toBe(0);
  });
});
