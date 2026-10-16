import {
  type Attempt,
  applyCommand,
  type Catalog,
  CatalogSchema,
  createCatalogIndex,
  TimelineSchema,
  WorkloadSchema,
} from "@archdrill/model";
import {
  cacheAsideAttempt,
  createLinkAttempt,
  testCatalog,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateTimeline } from "./timeline";
import { faultWindows } from "./timeline-faults";

/** The test catalog with a PostgreSQL that fails over in 20 seconds. */
function catalogWithFailover() {
  const copy: Catalog = JSON.parse(JSON.stringify(testCatalog));
  const postgres = copy.kinds.find((k) => k.id === "relational-db")?.flavors[0];
  if (!postgres) throw new Error("no relational database in the test catalog");
  postgres.failoverSec = 20;
  return createCatalogIndex(CatalogSchema.parse(copy));
}

const catalog = catalogWithFailover();

function context(attempt: Attempt) {
  return {
    attempt,
    catalog,
    problem: testProblem,
    analysis: analyzeAttempt(attempt, { catalog, problem: testProblem }),
  };
}

const timeline = (events: unknown[]) =>
  TimelineSchema.parse({
    id: "t",
    label: "Timeline",
    durationSec: 60,
    rates: { "create-link": 100 },
    events,
  });

const failover = { kind: "failover", target: { holds: "Link" }, mode: "crash" };
const spreadDb = (attempt: Attempt) =>
  applyCommand(attempt, "updateComponent", { id: "db", zones: 2 }).attempt;
/** Every component over two zones, as far as its instances go. */
const spreadAll = (attempt: Attempt) =>
  attempt.architecture.components.reduce(
    (spread, c) => applyCommand(spread, "updateComponent", { id: c.id, zones: 2 }).attempt,
    attempt,
  );

describe("faultWindows", () => {
  it("ends a failover the event leaves open when the store's replica has taken over", () => {
    const windows = faultWindows(
      timeline([{ kind: "fault", at: 10, fault: failover }]),
      context(cacheAsideAttempt()),
    );

    expect(windows).toMatchObject([{ from: 10, until: 30, failoverEnds: true }]);
  });

  it("keeps a store with no replica to promote down to the end", () => {
    const single = applyCommand(cacheAsideAttempt(), "updateComponent", {
      id: "db",
      replicas: 1,
    }).attempt;

    const windows = faultWindows(
      timeline([{ kind: "fault", at: 10, fault: failover }]),
      context(single),
    );

    expect(windows).toMatchObject([{ from: 10, until: undefined, failoverEnds: false }]);
  });

  it("does not fail over a store that lost every replica with the zone", () => {
    const windows = faultWindows(
      timeline([{ kind: "fault", at: 10, fault: { kind: "zone-down" } }]),
      context(cacheAsideAttempt()),
    ).filter((w) => w.component.id === "db");

    expect(windows).toMatchObject([{ from: 10, until: undefined, failoverEnds: false }]);
  });

  it("keeps the end an event gives", () => {
    const windows = faultWindows(
      timeline([{ kind: "fault", at: 10, until: 50, fault: failover }]),
      context(cacheAsideAttempt()),
    );

    expect(windows).toMatchObject([{ from: 10, until: 50, failoverEnds: false }]);
  });

  it("fails over the primaries a lost zone held, then leaves only the instances lost", () => {
    const windows = faultWindows(
      timeline([{ kind: "fault", at: 10, fault: { kind: "zone-down" } }]),
      context(spreadDb(cacheAsideAttempt())),
    ).filter((w) => w.component.id === "db");

    expect(windows).toMatchObject([
      { from: 10, until: 30, failingOver: true, failoverEnds: true },
      { from: 30, until: undefined, failoverEnds: false },
    ]);
  });
});

describe("failovers over time", () => {
  const workload = WorkloadSchema.parse({
    operations: { "create-link": { entity: "Link", classes: [{ id: "generated", share: 1 }] } },
    keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
    environments: [{ id: "steady", label: "Steady", rates: { "create-link": 100 } }],
  });
  const attempt = createLinkAttempt("kgs", 1000);
  const success = (events: unknown[], target: Attempt = attempt) => {
    const result = simulateTimeline(workload, timeline(events), context(target));
    const series = result.operations.get("create-link")?.successRate ?? [];
    return { result, at: (t: number) => series[result.times.indexOf(t)] ?? Number.NaN };
  };

  it("fails writes for as long as the store's failover takes", () => {
    const { result, at } = success([{ kind: "fault", at: 10, fault: failover }]);

    expect(at(5)).toBeCloseTo(1, 6);
    expect(at(15)).toBeCloseTo(0, 6);
    expect(at(35)).toBeCloseTo(1, 6);
    expect(result.marks).toContainEqual(
      expect.objectContaining({ at: 30, kind: "fault-end", label: "failover: holds Link" }),
    );
  });

  it("fails writes to a lost zone's primaries until a replica in another zone takes over", () => {
    const { result, at } = success(
      [{ kind: "fault", at: 10, fault: { kind: "zone-down" } }],
      spreadAll(attempt),
    );

    expect(at(15)).toBeCloseTo(0, 6);
    expect(at(35)).toBeCloseTo(1, 6);
    expect(result.marks).toContainEqual(
      expect.objectContaining({ at: 30, kind: "failed-over", componentIds: ["db"] }),
    );
    expect(result.marks.some((m) => m.kind === "fault-end")).toBe(false);
  });
});
