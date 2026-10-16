import {
  type Attempt,
  applyCommand,
  EnvironmentSchema,
  type Timeline,
  TimelineSchema,
  WorkloadSchema,
} from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateEnvironment } from "./simulate";
import { ratesAt, simulateTimeline } from "./timeline";

const workload = WorkloadSchema.parse({
  operations: {
    redirect: {
      entity: "Link",
      classes: [
        { id: "live", share: 0.985 },
        { id: "expired", share: 0.005, expired: true },
        { id: "unknown", share: 0.01, exists: false },
      ],
    },
  },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
  environments: [{ id: "steady", label: "Steady", rates: { redirect: 6000 } }],
});

const timeline = (fields: Record<string, unknown>): Timeline =>
  TimelineSchema.parse({
    id: "t",
    label: "Timeline",
    durationSec: 60,
    rates: { redirect: 6000 },
    ...fields,
  });

function context(attempt: Attempt) {
  return {
    attempt,
    catalog: testCatalogIndex,
    problem: testProblem,
    analysis: analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem }),
  };
}

const at = (times: readonly number[], series: readonly number[], t: number) =>
  series[times.indexOf(t)] ?? Number.NaN;

describe("ratesAt", () => {
  it("steps and ramps rates in order of their events", () => {
    const shaped = timeline({
      events: [
        { kind: "load", at: 10, rates: { redirect: 12000 } },
        { kind: "load", at: 30, rates: { redirect: 2000 }, rampSec: 20 },
      ],
    });

    expect(ratesAt(shaped, 5).redirect).toBe(6000);
    expect(ratesAt(shaped, 10).redirect).toBe(12000);
    expect(ratesAt(shaped, 40).redirect).toBe(7000);
    expect(ratesAt(shaped, 55).redirect).toBe(2000);
  });

  it("grows by the same factor every second on an exponential ramp", () => {
    const viral = timeline({
      events: [
        { kind: "load", at: 0, rates: { redirect: 60000 }, rampSec: 20, curve: "exponential" },
      ],
    });

    expect(ratesAt(viral, 10).redirect).toBeCloseTo(6000 * Math.sqrt(10), 6);
    expect(ratesAt(viral, 20).redirect).toBeCloseTo(60000, 6);
  });
});

describe("simulateTimeline", () => {
  it("settles on the steady state when nothing happens", () => {
    const ctx = context(cacheAsideAttempt());
    const result = simulateTimeline(workload, timeline({ durationSec: 10 }), ctx);
    const steady = simulateEnvironment(
      workload,
      EnvironmentSchema.parse({ id: "steady", label: "Steady", rates: { redirect: 6000 } }),
      ctx,
    );
    const last = result.times.length - 1;

    expect(result.times).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.unsettledSteps).toBe(0);
    for (const [id, component] of steady.components) {
      expect(result.components.get(id)?.utilization[last]).toBeCloseTo(
        Math.max(component.utilization, component.hottestShardUtilization),
        6,
      );
    }
    const redirect = result.operations.get("redirect");
    const expected = steady.operations.get("redirect");
    expect(redirect?.successRate[last]).toBeCloseTo(expected?.successRate ?? 0, 9);
    expect(redirect?.p99[last]).toBeCloseTo(expected?.latency.p99 ?? 0, 3);
  });

  it("routes between zones with the instances an autoscaled fleet runs at each step", () => {
    // Three instances match Redis's replicas zone for zone; ten (4, 3 and 3) do not quite.
    let attempt = cacheAsideAttempt();
    for (const [name, args] of [
      ["updateComponent", { id: "api", replicas: 3, zones: 3 }],
      ["updateComponent", { id: "redis", replicas: 3, zones: 3 }],
      ["setAutoscale", { id: "api", autoscale: { max: 30, targetUtilization: 0.2 } }],
      ["setConnectionPolicy", { id: "api--redis", sameZone: true }],
    ] as const) {
      attempt = applyCommand(attempt, name, args as never).attempt;
    }
    const ctx = context(attempt);
    const result = simulateTimeline(workload, timeline({ durationSec: 600, stepSec: 10 }), ctx);
    const steady = simulateEnvironment(
      workload,
      EnvironmentSchema.parse({ id: "steady", label: "Steady", rates: { redirect: 6000 } }),
      ctx,
    );
    const last = result.times.length - 1;

    expect(result.components.get("api")?.instances[last]).toBe(
      steady.components.get("api")?.instances,
    );
    expect(result.operations.get("redirect")?.p50[last]).toBeCloseTo(
      steady.operations.get("redirect")?.latency.p50 ?? 0,
      3,
    );
  });

  it("shows a fault only while it lasts", () => {
    const outage = timeline({
      events: [
        {
          kind: "fault",
          at: 20,
          until: 40,
          fault: { kind: "down", target: { capability: "volatile-kv" } },
          label: "Redis down",
        },
      ],
    });
    const result = simulateTimeline(workload, outage, context(cacheAsideAttempt()));
    const db = result.components.get("db")?.utilization ?? [];
    const hits = result.caches.get("redis|Link") ?? [];

    expect(at(result.times, hits, 10)).toBeGreaterThan(0.5);
    expect(at(result.times, hits, 30)).toBeCloseTo(0, 4);
    expect(at(result.times, db, 30)).toBeGreaterThan(at(result.times, db, 10) * 2);
    // Redis comes back empty: the database stays busier while it fills up again.
    expect(at(result.times, db, 50)).toBeLessThan(at(result.times, db, 30));
    expect(at(result.times, db, 50)).toBeGreaterThan(at(result.times, db, 10));
    expect(result.marks.map((m) => `${m.at} ${m.kind} ${m.label}`)).toEqual(
      expect.arrayContaining([
        "20 fault-start Redis down",
        "40 fault-end Redis down",
        "40 restart Back after the outage",
      ]),
    );
  });

  it("follows a ramp and marks the components it pushes over capacity", () => {
    const ramp = timeline({
      durationSec: 30,
      events: [{ kind: "load", at: 0, rates: { redirect: 60000 }, rampSec: 30 }],
    });
    const result = simulateTimeline(workload, ramp, context(cacheAsideAttempt()));
    const rate = result.operations.get("redirect")?.rate ?? [];

    expect(at(result.times, rate, 15)).toBeCloseTo(33000, 6);
    expect(result.marks.some((m) => m.kind === "overload-start")).toBe(true);
    const success = result.operations.get("redirect")?.successRate ?? [];
    expect(at(result.times, success, 30)).toBeLessThan(at(result.times, success, 0));
  });

  it("keeps every series aligned with the steps when an operation stops", () => {
    const stop = timeline({
      durationSec: 20,
      events: [{ kind: "load", at: 10, rates: { redirect: 0 } }],
    });
    const result = simulateTimeline(workload, stop, context(cacheAsideAttempt()));
    const redirect = result.operations.get("redirect");

    for (const values of [redirect?.rate, redirect?.successRate, redirect?.p99]) {
      expect(values).toHaveLength(result.times.length);
    }
    expect(at(result.times, redirect?.rate ?? [], 15)).toBe(0);
    for (const series of result.caches.values()) expect(series).toHaveLength(result.times.length);
  });

  it("answers its predictions from what happened", () => {
    const outage = timeline({
      events: [
        {
          kind: "fault",
          at: 20,
          until: 40,
          fault: { kind: "down", target: { capability: "durable-store" } },
        },
      ],
      predictions: [
        {
          id: "lowest",
          question: "How low do redirects go?",
          measure: { kind: "lowest-success", operation: "redirect" },
          options: [
            { id: "most-fail", label: "Most fail", below: 0.5 },
            { id: "some-fail", label: "Some fail", below: 0.999 },
            { id: "unaffected", label: "Unaffected" },
          ],
        },
        {
          id: "recovery",
          question: "When are they back?",
          measure: { kind: "recovery-seconds", operation: "redirect", threshold: 0.999, after: 20 },
          options: [
            { id: "fast", label: "Within 10 s", below: 10 },
            { id: "slow", label: "Later" },
          ],
        },
        {
          id: "store",
          question: "How busy is the store?",
          measure: { kind: "peak-utilization", target: { capability: "durable-store" } },
          options: [
            { id: "calm", label: "Under half", below: 0.5 },
            { id: "busy", label: "More" },
          ],
        },
      ],
    });
    const result = simulateTimeline(workload, outage, context(cacheAsideAttempt()));

    expect(result.predictions.get("lowest")?.optionId).toBe("some-fail");
    expect(result.predictions.get("recovery")).toEqual({ value: 20, optionId: "slow" });
    expect(result.predictions.get("store")?.optionId).toBe("calm");
    // What the canvas and the path mix need at every step.
    const db = result.components.get("db");
    expect(db?.faults[30]).not.toEqual([]);
    expect(db?.faults[10]).toEqual([]);
    expect(result.connections.get("api--db")).toHaveLength(result.times.length);
    const mix = result.paths.get("redirect")?.[30] ?? [];
    expect(mix.reduce((sum, p) => sum + p.share, 0)).toBeCloseTo(1, 3);
  });

  it("is deterministic", () => {
    const outage = timeline({
      events: [
        {
          kind: "fault",
          at: 5,
          until: 15,
          fault: { kind: "down", target: { capability: "volatile-kv" } },
        },
      ],
    });
    const ctx = context(cacheAsideAttempt());

    expect(simulateTimeline(workload, outage, ctx)).toEqual(
      simulateTimeline(workload, outage, ctx),
    );
  });
});
