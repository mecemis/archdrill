import { type Attempt, applyCommand, type Flow } from "@archdrill/model";
import {
  asyncAttempt,
  cacheAsideAttempt,
  testCatalogIndex,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import type { AnyCommand } from "../../state/attempt-store";
import {
  appendStep,
  type EditContext,
  insertBefore,
  removeStep,
  setExit,
  withPruning,
} from "./flow-edits";
import { type Sequence, sequenceOf } from "./sequence";

const redirect = testProblem.operations.find((o) => o.id === "redirect");
if (!redirect) throw new Error("no redirect operation");

function context(attempt: Attempt, problem = testProblem): EditContext {
  return {
    flow: attempt.flows.find((f) => f.operation === "redirect") as Flow,
    attempt,
    problem,
    operation: redirect as NonNullable<typeof redirect>,
    catalog: testCatalogIndex,
    background: false,
  };
}

function apply(attempt: Attempt, commands: readonly AnyCommand[]): Attempt {
  return commands.reduce((a, c) => applyCommand(a, c.name, c.args as never).attempt, attempt);
}

/** A sequence as text: "step(continuing) [exits] … → end". */
function outline(sequence: Sequence): string {
  const items = sequence.items.map((item) => {
    const exits = item.exits.map((e) =>
      e.kind === "respond"
        ? `${e.outcome}→${e.status}`
        : e.kind === "goto"
          ? `${e.outcome}→#${e.number}`
          : e.kind === "branch"
            ? `${e.outcome}→{${outline(e.branch)}}`
            : `${e.outcome}→?`,
    );
    return `${item.stepId}(${item.continuing.join(",")})${exits.length ? `[${exits.join(" ")}]` : ""}`;
  });
  const end = sequence.end;
  const tail =
    end.kind === "respond"
      ? `${end.status}`
      : end.kind === "goto"
        ? `#${end.number}`
        : end.kind === "open"
          ? `open(${end.outcomes.join(",")})`
          : "empty";
  return [...items, tail].join(" > ");
}

const flowOf = (attempt: Attempt) => attempt.flows.find((f) => f.operation === "redirect") as Flow;

describe("sequenceOf", () => {
  it("reads cache-aside as the miss path, with the hit as a branch of its own", () => {
    const attempt = cacheAsideAttempt();

    expect(outline(sequenceOf(flowOf(attempt), attempt))).toBe(
      "get(miss,error)[hit→{expiryHit(valid)[expired→410] > 302}] > read(found)[notFound→404 error→503] > expiryDb(valid)[expired→410] > populate(ok,error) > 302",
    );
  });

  it("shows a link back to an earlier step as a jump", () => {
    const attempt = apply(cacheAsideAttempt(), [
      {
        name: "linkOutcome",
        args: { operation: "redirect", stepId: "read", outcome: "error", target: "get" },
      },
    ]);

    expect(outline(sequenceOf(flowOf(attempt), attempt))).toContain("error→#1");
  });
});

describe("flow edits in a consumer", () => {
  it("leads a local-list match into the API call put after it, and finishes when clean", () => {
    let attempt = apply(asyncAttempt({ localList: true }), [
      { name: "removeStep", args: { operation: "scan-link", stepId: "match", bypass: "match" } },
    ]);
    const scan = testProblem.operations.find((o) => o.id === "scan-link");
    const scanFlow = () => attempt.flows.find((f) => f.operation === "scan-link") as Flow;
    attempt = apply(
      attempt,
      insertBefore(
        {
          flow: scanFlow(),
          attempt,
          problem: testProblem,
          operation: scan as NonNullable<typeof scan>,
          catalog: testCatalogIndex,
          background: true,
        },
        { kind: "root" },
        "check",
        { type: "logic", logic: "matchThreatList" },
      ),
    );

    const match = scanFlow().steps["match-threat-list"];
    expect(scanFlow().root).toBe("match-threat-list");
    expect(match?.type === "logic" && match.next.match).toBe("check");
    expect(match?.type === "logic" && scanFlow().steps[match.next.clean ?? ""]).toEqual({
      type: "respond",
      status: 200,
    });
  });

  it.each([
    ["matchThreatList", "match-threat-list(clean)[match→?] > open(clean)"],
    ["isLargeGroup", "is-large-group(small)[large→?] > open(small)"],
  ] as const)("leaves the other way of %s open instead of finishing on it", (logic, expected) => {
    let attempt = apply(asyncAttempt({ localList: true }), [
      { name: "removeFlow", args: { operation: "scan-link" } },
      { name: "createFlow", args: { operation: "scan-link", handler: "worker" } },
    ]);
    const scan = testProblem.operations.find((o) => o.id === "scan-link");
    const scanFlow = () => attempt.flows.find((f) => f.operation === "scan-link") as Flow;
    attempt = apply(
      attempt,
      appendStep(
        {
          flow: scanFlow(),
          attempt,
          problem: testProblem,
          operation: scan as NonNullable<typeof scan>,
          catalog: testCatalogIndex,
          background: true,
        },
        { kind: "root" },
        { type: "logic", logic },
      ),
    );

    expect(outline(sequenceOf(scanFlow(), attempt))).toBe(expected);
  });
});

describe("flow edits", () => {
  const empty = (): Attempt =>
    apply(cacheAsideAttempt(), [
      { name: "removeFlow", args: { operation: "redirect" } },
      { name: "createFlow", args: { operation: "redirect", handler: "api" } },
    ]);

  it("adds a step with its usual exits and leaves the way on open", () => {
    let attempt = empty();
    attempt = apply(
      attempt,
      appendStep(
        context(attempt),
        { kind: "root" },
        {
          type: "call",
          target: "db",
          action: "store.read",
          entity: "Link",
        },
      ),
    );

    expect(outline(sequenceOf(flowOf(attempt), attempt))).toBe(
      "read-link(found)[notFound→404 error→503] > open(found)",
    );
  });

  it("answers a cache hit with the chosen redirect status and carries on after a miss or an error", () => {
    // Real problems name redirect options by their status.
    const problem = {
      ...testProblem,
      decisionPoints: testProblem.decisionPoints.map((d) =>
        d.id === "redirect-status"
          ? {
              ...d,
              options: [
                { id: "301", label: "301" },
                { id: "302", label: "302" },
              ],
            }
          : d,
      ),
    };
    let attempt: Attempt = { ...empty(), decisions: { "redirect-status": "302" } };
    attempt = apply(
      attempt,
      appendStep(
        context(attempt, problem),
        { kind: "root" },
        {
          type: "call",
          target: "redis",
          action: "cache.get",
          entity: "Link",
        },
      ),
    );

    expect(outline(sequenceOf(flowOf(attempt), attempt))).toBe(
      "get-link(miss,error)[hit→302] > open(miss,error)",
    );
  });

  it("puts the next step behind every continuing outcome, and shares response steps", () => {
    let attempt = empty();
    const read = { type: "call", target: "db", action: "store.read", entity: "Link" } as const;
    attempt = apply(
      attempt,
      appendStep(
        context(attempt),
        { kind: "root" },
        { type: "call", target: "redis", action: "cache.get", entity: "Link" },
      ),
    );
    attempt = apply(
      attempt,
      appendStep(
        context(attempt),
        { kind: "after", stepId: "get-link", outcomes: ["miss", "error"] },
        read,
      ),
    );
    attempt = apply(
      attempt,
      appendStep(
        context(attempt),
        { kind: "after", stepId: "read-link", outcomes: ["found"] },
        { type: "respond", status: 302 },
      ),
    );

    expect(outline(sequenceOf(flowOf(attempt), attempt))).toBe(
      "get-link(miss,error)[hit→301] > read-link(found)[notFound→404 error→503] > 302",
    );
    // One response step per status, however many outcomes lead to it.
    const statuses = Object.values(flowOf(attempt).steps).flatMap((s) =>
      s.type === "respond" ? [s.status] : [],
    );
    expect(statuses.sort()).toEqual([301, 302, 404, 503]);
  });

  it("inserts a step in front of another, carrying on into it", () => {
    const attempt = cacheAsideAttempt();
    const after = apply(
      attempt,
      insertBefore(
        context(attempt),
        { kind: "after", stepId: "get", outcomes: ["miss", "error"] },
        "read",
        {
          type: "logic",
          logic: "validateUrl",
        },
      ),
    );

    expect(outline(sequenceOf(flowOf(after), after))).toContain(
      "get(miss,error)[hit→{expiryHit(valid)[expired→410] > 302}] > validate-url(valid)[invalid→400] > read(found)",
    );
  });

  it("replaces a branch with a response and removes the steps it cut off", () => {
    const attempt = cacheAsideAttempt();
    const commands = withPruning(
      attempt,
      "redirect",
      setExit(context(attempt), "get", ["hit"], { kind: "respond", status: 302 }),
    );
    const after = apply(attempt, commands);

    expect(outline(sequenceOf(flowOf(after), after))).toContain("get(miss,error)[hit→302]");
    expect(flowOf(after).steps.expiryHit).toBeUndefined();
  });

  it("removes a step and joins what came before to what followed", () => {
    const attempt = cacheAsideAttempt();
    const after = apply(attempt, removeStep(context(attempt), "expiryDb", ["valid"]));

    expect(outline(sequenceOf(flowOf(after), after))).toContain(
      "read(found)[notFound→404 error→503] > populate(ok,error) > 302",
    );
  });
});

describe("sequenceOf on every reference design", () => {
  it("shows every reachable step exactly once, and every outcome somewhere", async () => {
    const { goldenDesigns } = await import("@archdrill/content");
    const { feasibleOutcomes, liveStepIds } = await import("@archdrill/model");
    for (const golden of Object.values(goldenDesigns).flat()) {
      for (const flow of golden.attempt.flows) {
        const shown: string[] = [];
        const outcomes = new Map<string, Set<string>>();
        const walk = (sequence: Sequence) => {
          for (const item of sequence.items) {
            shown.push(item.stepId);
            const seen = new Set([...item.continuing, ...item.exits.map((e) => e.outcome)]);
            outcomes.set(item.stepId, seen);
            for (const exit of item.exits) if (exit.kind === "branch") walk(exit.branch);
          }
        };
        walk(sequenceOf(flow, golden.attempt));
        const live = liveStepIds(flow, golden.attempt).filter(
          (id) => flow.steps[id]?.type !== "respond",
        );
        const where = `${golden.id} / ${flow.operation}`;
        expect([...shown].sort(), where).toEqual([...live].sort());
        for (const id of live) {
          const step = flow.steps[id];
          if (!step) continue;
          expect([...(outcomes.get(id) ?? [])].sort(), `${where} / ${id}`).toEqual(
            [...feasibleOutcomes(step, golden.attempt)].sort(),
          );
        }
      }
    }
  });
});
