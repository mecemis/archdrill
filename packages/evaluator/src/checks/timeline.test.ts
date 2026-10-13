import { WorkloadSchema } from "@archdrill/model";
import { cacheAsideAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { runCheckWithTimelines } from "../test-support";

const workload = WorkloadSchema.parse({
  operations: {
    redirect: { entity: "Link", classes: [{ id: "live", share: 1 }] },
  },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
  environments: [{ id: "steady", label: "Steady", rates: { redirect: 6000 } }],
  timelines: [
    {
      id: "db-outage",
      label: "Database outage",
      durationSec: 60,
      rates: { redirect: 6000 },
      events: [
        {
          kind: "fault",
          at: 20,
          until: 40,
          fault: { kind: "down", target: { capability: "durable-store" } },
          label: "Postgres down",
        },
      ],
    },
    {
      id: "surge",
      label: "Surge",
      durationSec: 30,
      rates: { redirect: 6000 },
      events: [{ kind: "load", at: 10, rates: { redirect: 60000 } }],
    },
  ],
});

const run = (id: string, params: Record<string, unknown>) =>
  runCheckWithTimelines(id, params, cacheAsideAttempt(), workload);

const successHolds = {
  timeline: "db-outage",
  metric: "success-rate",
  operation: "redirect",
  threshold: 0.999,
};

describe("timeline-holds", () => {
  it("measures how long a metric spends out of bounds, and when", () => {
    const outcome = run("timeline-holds", successHolds);

    expect(outcome.status).toBe("partial");
    expect(outcome.fraction).toBeCloseTo(1 - 20 / 61, 6);
    expect(outcome.message).toMatch(
      /is out of bounds \(below 99\.9%\) for 20 s of Database outage/,
    );
    expect(outcome.details).toEqual(["from 20 s to 39 s"]);
    expect(outcome.evidence).toContainEqual({ type: "component", componentId: "db" });
  });

  it("allows a grace period, and only judges its window", () => {
    expect(run("timeline-holds", { ...successHolds, graceSec: 20 }).status).toBe("pass");
    expect(run("timeline-holds", { ...successHolds, from: 40 }).status).toBe("pass");
  });

  it("points at what runs over capacity", () => {
    const outcome = run("timeline-holds", {
      timeline: "surge",
      metric: "utilization",
      threshold: 0.85,
    });

    expect(outcome.status).not.toBe("pass");
    expect(outcome.evidence.length).toBeGreaterThan(0);
  });

  it("does not apply to a timeline the scenario does not run", () => {
    expect(run("timeline-holds", { ...successHolds, timeline: "nope" }).status).toBe("n/a");
  });
});

describe("timeline-recovers", () => {
  const recovers = { ...successHolds, metric: "success-rate" };

  it("passes when the metric is back within bounds in time", () => {
    const outcome = run("timeline-recovers", { ...recovers, after: 40, withinSec: 5 });

    expect(outcome.status).toBe("pass");
    expect(outcome.message).toMatch(/stays above 99\.9% from 40 s/);
  });

  it("gives partial credit for a late recovery", () => {
    const outcome = run("timeline-recovers", { ...recovers, after: 20, withinSec: 5 });

    expect(outcome.status).toBe("partial");
    expect(outcome.fraction).toBeCloseTo(5 / 20, 6);
    expect(outcome.message).toMatch(/is back above 99\.9% 20 s after 20 s/);
  });

  it("fails when the metric never recovers", () => {
    const outcome = run("timeline-recovers", {
      timeline: "surge",
      metric: "success-rate",
      operation: "redirect",
      threshold: 0.999,
      after: 10,
      withinSec: 5,
    });

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(/is not back above 99\.9% by the end of Surge/);
  });
});
