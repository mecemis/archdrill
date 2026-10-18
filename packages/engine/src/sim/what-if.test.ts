import { type Attempt, applyCommand, EnvironmentSchema, WorkloadSchema } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateEnvironment } from "./simulate";
import { breakageOf, findBreakingPoint, MAX_TRAFFIC_FACTOR, scaledEnvironment } from "./what-if";

const workload = WorkloadSchema.parse({
  operations: { redirect: { entity: "Link", classes: [{ id: "live", share: 1 }] } },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
  environments: [{ id: "steady", label: "Steady", rates: { redirect: 6000 } }],
});

function context(attempt: Attempt) {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  return { attempt, catalog: testCatalogIndex, problem: testProblem, analysis };
}

const environment = (rates: Record<string, number>, faults: unknown[] = []) =>
  EnvironmentSchema.parse({ id: "env", label: "Env", rates, faults, connections: 100 });

describe("scaledEnvironment", () => {
  it("multiplies the users' requests and connections, not the scheduled jobs", () => {
    const scaled = scaledEnvironment(
      environment({ redirect: 6000, "purge-expired": 50 }),
      3,
      testProblem,
    );

    expect(scaled.rates).toEqual({ redirect: 18000, "purge-expired": 50 });
    expect(scaled.connections).toBe(300);
  });
});

describe("breakageOf", () => {
  it("counts a load the model cannot settle as broken, whatever else it shows", () => {
    const unsettled = {
      components: new Map(),
      operations: new Map(),
      calls: new Map(),
      pools: new Map(),
      converged: false,
    };

    expect(breakageOf(unsettled as never, [])).toMatchObject({ unsettled: true, overloaded: [] });
    expect(breakageOf({ ...unsettled, converged: true } as never, [])).toBeNull();
  });
});

describe("findBreakingPoint", () => {
  it("finds the traffic the design first fails at, and what gives", () => {
    const ctx = context(cacheAsideAttempt());
    const point = findBreakingPoint(workload, environment({ redirect: 6000 }), ctx, ["redirect"]);

    expect(point.factor).not.toBeNull();
    expect(point.holds).toBeGreaterThan(1);
    // Within a percent of each other, the first that broke above the last that held.
    expect((point.factor ?? 0) / point.holds).toBeLessThanOrEqual(1.0101);
    expect(point.breakage?.overloaded.length ?? 0).toBeGreaterThan(0);

    const at = (factor: number) =>
      breakageOf(
        simulateEnvironment(
          workload,
          scaledEnvironment(environment({ redirect: 6000 }), factor, testProblem),
          ctx,
        ),
        ["redirect"],
      );
    expect(at(point.holds)).toBeNull();
    expect(at(point.factor ?? 0)).not.toBeNull();
  });

  it("says so when the environment's own traffic already breaks the design", () => {
    const cacheDown = [{ kind: "down", target: { capability: "volatile-kv" } }];
    const point = findBreakingPoint(
      workload,
      environment({ redirect: 200_000 }, cacheDown),
      context(cacheAsideAttempt()),
      ["redirect"],
    );

    expect(point).toMatchObject({ factor: 1, holds: 0 });
    expect(point.breakage?.failing[0]?.operation).toBe("redirect");
  });

  it("names a bulkhead that sheds calls before anything is over capacity", () => {
    const capped = applyCommand(cacheAsideAttempt(), "setConnectionPolicy", {
      id: "api--db",
      maxRps: 500,
    }).attempt;
    const cacheDown = [{ kind: "down", target: { capability: "volatile-kv" } }];
    const point = findBreakingPoint(
      workload,
      environment({ redirect: 6000 }, cacheDown),
      context(capped),
      ["redirect"],
    );

    expect(point.factor).toBe(1);
    expect(point.breakage?.limited[0]).toMatchObject({ connectionId: "api--db", by: "bulkhead" });
  });

  it("gives up at the most traffic it tries", () => {
    // Almost nothing to serve: the design holds far beyond the search's ceiling.
    const point = findBreakingPoint(
      workload,
      environment({ redirect: 0.001 }),
      context(cacheAsideAttempt()),
      ["redirect"],
    );

    expect(point).toEqual({ factor: null, holds: MAX_TRAFFIC_FACTOR, breakage: null });
  });
});
