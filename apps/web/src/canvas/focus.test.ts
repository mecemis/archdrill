import { analyzeAttempt } from "@archdrill/engine";
import { applyCommand } from "@archdrill/model";
import {
  asyncAttempt,
  cacheAsideAttempt,
  testCatalogIndex,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { outOfFocus } from "./focus";

const analyze = (attempt = asyncAttempt()) =>
  analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });

const sorted = (ids: ReadonlySet<string>) => [...ids].sort();

describe("outOfFocus", () => {
  it("leaves out what only operations outside the focus use", () => {
    const faded = outOfFocus(analyze(), ["redirect"]);

    // The cache and the database serve redirects too, so they stay in view.
    expect(sorted(faded.components)).toEqual(["kgs", "queue", "safety", "worker"]);
    expect(sorted(faded.connections)).toEqual([
      "api--kgs",
      "api--queue",
      "worker--db",
      "worker--queue",
      "worker--redis",
      "worker--safety",
    ]);
  });

  it("keeps what any focus operation uses", () => {
    const faded = outOfFocus(analyze(), ["redirect", "create-link"]);

    expect(sorted(faded.components)).toEqual(["safety", "worker"]);
    expect(faded.connections.has("api--queue")).toBe(false);
    expect(faded.connections.has("worker--queue")).toBe(true);
  });

  it("keeps components no operation uses yet, such as one just added", () => {
    const withSpare = applyCommand(asyncAttempt(), "addComponent", {
      id: "spare",
      kind: "cache",
      flavor: "redis",
      label: "Spare",
      position: { x: 0, y: 0 },
    }).attempt;

    expect(outOfFocus(analyze(withSpare), ["redirect"]).components.has("spare")).toBe(false);
  });

  it("fades nothing while the focus operations use nothing", () => {
    const faded = outOfFocus(analyze(cacheAsideAttempt()), ["create-link"]);

    expect(faded.components.size + faded.connections.size).toBe(0);
  });
});
