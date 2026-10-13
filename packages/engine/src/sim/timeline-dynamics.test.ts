import {
  type Attempt,
  applyCommand,
  type Timeline,
  TimelineSchema,
  type Workload,
  WorkloadSchema,
} from "@archdrill/model";
import {
  asyncAttempt,
  cacheAsideAttempt,
  testCatalogIndex,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateTimeline } from "./timeline";
import { BREAKER_WAIT_SEC, DEFAULT_STARTUP_SEC } from "./timeline-dynamics";

const redirects = WorkloadSchema.parse({
  operations: { redirect: { entity: "Link", classes: [{ id: "live", share: 1 }] } },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
  environments: [{ id: "steady", label: "Steady", rates: { redirect: 6000 } }],
});

const timeline = (fields: Record<string, unknown>): Timeline =>
  TimelineSchema.parse({ id: "t", label: "Timeline", durationSec: 60, ...fields });

function run(attempt: Attempt, workload: Workload, spec: Timeline) {
  return simulateTimeline(workload, spec, {
    attempt,
    catalog: testCatalogIndex,
    problem: testProblem,
    analysis: analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem }),
  });
}

const valueAt = (times: readonly number[], series: readonly number[] | undefined, t: number) =>
  series?.[times.indexOf(t)] ?? Number.NaN;

const redisRestart = (rate: number) =>
  timeline({
    rates: { redirect: rate },
    events: [{ kind: "restart", at: 10, target: { capability: "volatile-kv" } }],
  });

describe("restarted caches", () => {
  it("start empty and fill up, while the store takes the misses", () => {
    const result = run(cacheAsideAttempt(), redirects, redisRestart(6000));
    const hits = result.caches.get("redis|Link") ?? [];
    const db = result.components.get("db")?.utilization;

    expect(valueAt(result.times, hits, 10)).toBeCloseTo(0, 4);
    expect(valueAt(result.times, hits, 12)).toBeLessThan(valueAt(result.times, hits, 30));
    expect(valueAt(result.times, hits, 30)).toBeLessThan(valueAt(result.times, hits, 5));
    expect(valueAt(result.times, db, 10)).toBeGreaterThan(valueAt(result.times, db, 30));
    expect(result.marks.some((m) => m.kind === "restart" && m.componentIds.includes("redis"))).toBe(
      true,
    );
  });

  it("fill up faster when misses for one key share a single store read", () => {
    // A stampede big enough to overload the store, so each cold key's first read is slow.
    const plain = run(cacheAsideAttempt(), redirects, redisRestart(45000));
    const coalesced = run(
      applyCommand(cacheAsideAttempt(), "updateStep", {
        operation: "redirect",
        stepId: "read",
        coalesce: true,
      }).attempt,
      redirects,
      redisRestart(45000),
    );
    const hitsAt = (r: typeof plain, t: number) => valueAt(r.times, r.caches.get("redis|Link"), t);

    expect(hitsAt(coalesced, 12)).toBeGreaterThan(hitsAt(plain, 12));
  });
});

describe("autoscaling", () => {
  const scaled = applyCommand(cacheAsideAttempt(), "setAutoscale", {
    id: "api",
    autoscale: { max: 30, targetUtilization: 0.6 },
  }).attempt;
  const surge = timeline({
    durationSec: 120,
    rates: { redirect: 3000 },
    events: [{ kind: "load", at: 10, rates: { redirect: 15000 } }],
  });

  it("leaves a surge unserved until new instances have started", () => {
    const result = run(scaled, redirects, surge);
    const success = result.operations.get("redirect")?.successRate;
    const instances = result.components.get("api")?.instances;

    expect(valueAt(result.times, success, 20)).toBeLessThan(0.99);
    expect(valueAt(result.times, instances, 20)).toBe(valueAt(result.times, instances, 5));
    const ready = 10 + DEFAULT_STARTUP_SEC + 5;
    expect(valueAt(result.times, instances, ready)).toBeGreaterThan(
      valueAt(result.times, instances, 5),
    );
    expect(valueAt(result.times, success, 110)).toBeCloseTo(1, 6);
    expect(result.marks.some((m) => m.kind === "scale-out")).toBe(true);
  });

  it("settles where the steady state does when the load does not change", () => {
    const result = run(scaled, redirects, timeline({ durationSec: 30, rates: { redirect: 9000 } }));
    const instances = result.components.get("api")?.instances ?? [];

    expect(new Set(instances).size).toBe(1);
    expect(result.marks).toEqual([]);
  });
});

describe("circuit breakers", () => {
  it("keep failing fast until their next trial call after the dependency is back", () => {
    const guarded = applyCommand(cacheAsideAttempt(), "setConnectionPolicy", {
      id: "api--db",
      circuitBreaker: true,
      timeoutMs: 100,
    }).attempt;
    const outage = timeline({
      rates: { redirect: 6000 },
      events: [
        {
          kind: "fault",
          at: 10,
          // Still failing at the trial call 10 s after opening, so it opens again until 30 s.
          until: 25,
          fault: { kind: "down", target: { capability: "durable-store" } },
        },
      ],
    });
    const result = run(guarded, redirects, outage);
    const success = result.operations.get("redirect")?.successRate;
    const reopened = result.marks.filter((m) => m.kind === "breaker-close");

    expect(result.marks.some((m) => m.kind === "breaker-open")).toBe(true);
    expect(valueAt(result.times, success, 27)).toBeLessThan(valueAt(result.times, success, 40));
    expect(reopened[0]?.at).toBe(10 + 2 * BREAKER_WAIT_SEC);
  });
});

describe("backlogs", () => {
  it("build while a job cannot keep up and drain once it can", () => {
    const work = WorkloadSchema.parse({
      operations: {
        "purge-expired": { entity: "Link", classes: [{ id: "expired", share: 1, expired: true }] },
      },
      keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
      environments: [{ id: "e", label: "E", rates: { "purge-expired": 1000 } }],
    });
    const burst = timeline({
      durationSec: 60,
      rates: { "purge-expired": 4000 },
      events: [{ kind: "load", at: 20, rates: { "purge-expired": 1000 } }],
    });
    const result = run(asyncAttempt({ workers: 1 }), work, burst);
    const backlog = result.operations.get("purge-expired")?.backlog;

    expect(valueAt(result.times, backlog, 20)).toBeGreaterThan(10_000);
    expect(valueAt(result.times, backlog, 50)).toBeCloseTo(0, 0);
    expect(valueAt(result.times, backlog, 25)).toBeLessThan(valueAt(result.times, backlog, 20));
  });
});
