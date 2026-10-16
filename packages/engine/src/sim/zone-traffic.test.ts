import {
  type Attempt,
  applyCommand,
  type CommandArgs,
  createCatalogIndex,
  EnvironmentSchema,
  WorkloadSchema,
} from "@archdrill/model";
import {
  cacheAsideAttempt,
  clickAnalyticsAttempt,
  testCatalog,
  testCatalogIndex,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateEnvironment } from "./simulate";
import {
  CROSS_ZONE_RTT_MS,
  CROSS_ZONE_USD_PER_GB,
  hopRoundTripMs,
  replicaRoundTripMs,
  SAME_ZONE_RTT_MS,
  zoneRoutes,
} from "./zone-traffic";

function apply<N extends Parameters<typeof applyCommand>[1]>(
  attempt: Attempt,
  name: N,
  args: CommandArgs<N>,
): Attempt {
  return applyCommand(attempt, name, args).attempt;
}

/** The cache-aside design with every component it places spread over `zones`. */
function spread(zones: number, attempt = cacheAsideAttempt()): Attempt {
  return ["api", "redis", "db"].reduce(
    (a, id) => apply(a, "updateComponent", { id, replicas: 3, zones }),
    attempt,
  );
}

/** The test catalog with its queue run by the design itself (Kafka), placed in zones. */
const selfRunLogCatalog = createCatalogIndex({
  ...testCatalog,
  kinds: testCatalog.kinds.map((kind) =>
    kind.id !== "queue"
      ? kind
      : { ...kind, flavors: kind.flavors.map((f) => ({ ...f, managedRedundancy: false })) },
  ),
});

const sameZone = (attempt: Attempt, id: string) =>
  apply(attempt, "setConnectionPolicy", { id, sameZone: true });

describe("zoneRoutes", () => {
  it("keeps every call in the zone when caller and target share their only zone", () => {
    const routes = zoneRoutes(spread(1), testCatalogIndex);

    expect(routes.get("api--redis")).toMatchObject({ crossRead: 0, crossWrite: 0 });
    expect(routes.get("api--db")).toMatchObject({ crossRead: 0, crossWrite: 0 });
  });

  it("gives a managed load balancer a node in a second zone, even for targets in one", () => {
    // An Application Load Balancer needs two zones; the node without targets forwards across.
    const route = zoneRoutes(spread(1), testCatalogIndex).get("lb--api");

    expect(route?.crossRead).toBeCloseTo(1 / 2);
  });

  it("sends two calls in three to another zone when both spread over three", () => {
    const route = zoneRoutes(spread(3), testCatalogIndex).get("api--redis");

    expect(route?.crossRead).toBeCloseTo(2 / 3);
    expect(route?.crossWrite).toBeCloseTo(2 / 3);
  });

  it("keeps reads in the zone with zone-aware routing, but not writes to a primary", () => {
    const route = zoneRoutes(sameZone(spread(3), "api--redis"), testCatalogIndex).get("api--redis");

    expect(route?.crossRead).toBeCloseTo(0);
    expect(route?.crossWrite).toBeCloseTo(2 / 3);
  });

  it("publishes to a partition's leader, but lets consumers read from their zone", () => {
    const catalog = selfRunLogCatalog;
    const attempt = ["api", "clicks", "counter"].reduce(
      (a, id) => apply(a, "updateComponent", { id, replicas: 3, zones: 3 }),
      clickAnalyticsAttempt(),
    );
    const aware = sameZone(sameZone(attempt, "api--clicks"), "counter--clicks");

    const routes = zoneRoutes(aware, catalog);

    expect(routes.get("counter--clicks")?.crossRead).toBeCloseTo(0);
    expect(routes.get("api--clicks")?.crossWrite).toBeCloseTo(2 / 3);
  });

  it("cannot keep calls in a zone the target has no instances in", () => {
    const oneZoneCache = apply(spread(3), "updateComponent", { id: "redis", zones: 1 });

    const route = zoneRoutes(sameZone(oneZoneCache, "api--redis"), testCatalogIndex).get(
      "api--redis",
    );

    expect(route?.crossRead).toBeCloseTo(2 / 3);
  });

  it("spreads what zone-aware routing cannot keep local so the target stays evenly loaded", () => {
    // Two zones of callers, three of targets: each zone keeps a third, the rest crosses.
    const callers = apply(spread(3), "updateComponent", { id: "api", replicas: 2, zones: 2 });

    const route = zoneRoutes(sameZone(callers, "api--redis"), testCatalogIndex).get("api--redis");

    expect(route?.crossRead).toBeCloseTo(1 / 3);
  });

  it("has a managed load balancer forward from nodes in every zone", () => {
    const routes = zoneRoutes(spread(3), testCatalogIndex);
    const aware = zoneRoutes(sameZone(spread(3), "lb--api"), testCatalogIndex);

    expect(routes.get("lb--api")?.crossRead).toBeCloseTo(2 / 3);
    expect(aware.get("lb--api")?.crossRead).toBeCloseTo(0);
  });

  it("leaves out hops from clients, which start outside the region", () => {
    expect(zoneRoutes(spread(3), testCatalogIndex).has("client--lb")).toBe(false);
  });

  it("leaves out calls to regional services, which answer where they choose", () => {
    expect(zoneRoutes(clickAnalyticsAttempt(), testCatalogIndex).has("api--clicks")).toBe(false);
  });

  it("bills each end that pays, and nothing on a hop through a managed load balancer", () => {
    const routes = zoneRoutes(spread(3), testCatalogIndex);

    expect(routes.get("api--db")?.usdPerGb).toBeCloseTo(2 * CROSS_ZONE_USD_PER_GB);
    expect(routes.get("lb--api")?.usdPerGb).toBe(0);
  });

  it("bills only the caller where the target's end is free (ElastiCache nodes)", () => {
    const catalog = createCatalogIndex({
      ...testCatalog,
      kinds: testCatalog.kinds.map((kind) =>
        kind.id !== "cache"
          ? kind
          : {
              ...kind,
              flavors: kind.flavors.map((f) => ({ ...f, crossZoneBilling: "other-end" as const })),
            },
      ),
    });

    expect(zoneRoutes(spread(3), catalog).get("api--redis")?.usdPerGb).toBeCloseTo(
      CROSS_ZONE_USD_PER_GB,
    );
  });
});

describe("hopRoundTripMs", () => {
  it("weighs the round trips within a zone and between zones by the share that crosses", () => {
    const route = {
      crossRead: 2 / 3,
      crossWrite: 0,
      sameZoneCross: { read: 0, write: 0 },
      usdPerGb: 0,
    };

    expect(hopRoundTripMs(route, false)).toBeCloseTo(
      SAME_ZONE_RTT_MS + (2 / 3) * (CROSS_ZONE_RTT_MS - SAME_ZONE_RTT_MS),
    );
    expect(hopRoundTripMs(route, true)).toBeCloseTo(SAME_ZONE_RTT_MS);
  });
});

describe("replicaRoundTripMs", () => {
  function db(attempt: Attempt) {
    const component = attempt.architecture.components.find((c) => c.id === "db");
    if (!component) throw new Error("no database");
    return component;
  }

  it("waits for a replica in another zone once the store spreads over zones", () => {
    expect(replicaRoundTripMs(db(spread(1)), testCatalogIndex, "semi-sync")).toBeCloseTo(
      SAME_ZONE_RTT_MS,
    );
    expect(replicaRoundTripMs(db(spread(3)), testCatalogIndex, "semi-sync")).toBeCloseTo(
      CROSS_ZONE_RTT_MS,
    );
  });

  it("acknowledges from a replica in the primary's zone when the shard has one there", () => {
    // Four replicas over three zones: the fourth shares the primary's zone.
    const four = db(apply(spread(3), "updateComponent", { id: "db", replicas: 4 }));

    expect(replicaRoundTripMs(four, testCatalogIndex, "semi-sync")).toBeCloseTo(SAME_ZONE_RTT_MS);
    expect(replicaRoundTripMs(four, testCatalogIndex, "sync")).toBeCloseTo(CROSS_ZONE_RTT_MS);
  });
});

const workload = WorkloadSchema.parse({
  operations: { redirect: { entity: "Link", classes: [{ id: "live", share: 1 }] } },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
  environments: [{ id: "steady", label: "Steady", rates: { redirect: 1 } }],
});

function simulate(attempt: Attempt, faults: unknown[] = []) {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  return simulateEnvironment(
    workload,
    EnvironmentSchema.parse({ id: "env", label: "Env", rates: { redirect: 6000 }, faults }),
    { attempt, catalog: testCatalogIndex, problem: testProblem, analysis },
  );
}

describe("traffic between zones in a simulation", () => {
  it("bills the bytes that cross zones to the component making the calls", () => {
    const metrics = simulate(spread(3));
    const toCache = metrics.zoneTraffic.get("api--redis");

    expect(toCache?.crossGbPerMonth).toBeGreaterThan(0);
    expect(toCache?.monthlyCost).toBeCloseTo(
      (toCache?.crossGbPerMonth ?? 0) * 2 * CROSS_ZONE_USD_PER_GB,
    );
    const calls = ["api--redis", "api--db"].map(
      (id) => metrics.zoneTraffic.get(id)?.monthlyCost ?? 0,
    );
    expect(metrics.components.get("api")?.costBreakdown.crossZone).toBeCloseTo(
      calls.reduce((a, b) => a + b, 0),
    );
  });

  it("charges nothing for a hop through a managed load balancer, though it crosses", () => {
    const fromLb = simulate(spread(3)).zoneTraffic.get("lb--api");

    expect(fromLb?.crossGbPerMonth).toBeGreaterThan(0);
    expect(fromLb?.monthlyCost).toBe(0);
  });

  it("says what zone-aware routing would save, and saves it when turned on", () => {
    const before = simulate(spread(3)).zoneTraffic.get("api--redis");
    const after = simulate(sameZone(spread(3), "api--redis")).zoneTraffic.get("api--redis");

    expect(before?.avoidableMonthlyCost).toBeGreaterThan(0);
    expect(after?.monthlyCost).toBeCloseTo(
      (before?.monthlyCost ?? 0) - (before?.avoidableMonthlyCost ?? 0),
    );
    expect(after?.avoidableMonthlyCost).toBe(0);
  });

  it("carries each request and its response on every hop on the way in", () => {
    const fromLb = simulate(spread(3)).zoneTraffic.get("lb--api");

    // 6,000 redirects a second of 600 bytes each way in and 300 back.
    expect(fromLb?.bytesPerSec.read).toBeCloseTo(6000 * 900, 0);
  });

  it("carries the value a cache hit returns, and the value a miss writes back", () => {
    const metrics = simulate(spread(3));
    const toCache = metrics.zoneTraffic.get("api--redis")?.bytesPerSec;
    const toStore = metrics.zoneTraffic.get("api--db")?.bytesPerSec;
    const hits = metrics.caches[0]?.hitRatio ?? 0;

    // Every redirect moves one 500-byte link to or from the cache, and misses read it from the store.
    expect((toCache?.read ?? 0) + (toCache?.write ?? 0)).toBeCloseTo(6000 * 500, 0);
    expect(toStore?.read).toBeCloseTo(6000 * (1 - hits) * 500, 0);
    expect(toStore?.write).toBe(0);
  });

  it("sends nothing to a cache that is down, and reads every link from the store", () => {
    const cacheDown = { kind: "down", target: { capability: "volatile-kv" }, mode: "crash" };
    const metrics = simulate(spread(3), [cacheDown]);
    const toCache = metrics.zoneTraffic.get("api--redis")?.bytesPerSec;

    expect((toCache?.read ?? 0) + (toCache?.write ?? 0)).toBe(0);
    expect(metrics.zoneTraffic.get("api--db")?.bytesPerSec.read).toBeCloseTo(6000 * 500, 0);
  });

  it("sends each click as a message of the event's own size, and delivers it whole", () => {
    // A click message carries a code and a time, not the 500-byte link it is about.
    const problem = {
      ...testProblem,
      events: testProblem.events.map((e) => (e.id === "link-clicked" ? { ...e, bytes: 100 } : e)),
    };
    const attempt = clickAnalyticsAttempt();
    const catalog = selfRunLogCatalog;
    const analysis = analyzeAttempt(attempt, { catalog, problem });
    const metrics = simulateEnvironment(
      workload,
      EnvironmentSchema.parse({ id: "env", label: "Env", rates: { redirect: 6000 } }),
      { attempt, catalog, problem, analysis },
    );
    const clicks = metrics.operations.get("record-click")?.rate ?? 0;

    expect(clicks).toBeGreaterThan(0);
    expect(metrics.zoneTraffic.get("api--clicks")?.bytesPerSec.write).toBeCloseTo(clicks * 100, 0);
    expect(metrics.zoneTraffic.get("counter--clicks")?.bytesPerSec.read).toBeCloseTo(
      clicks * 100,
      0,
    );
  });

  it("makes requests slower when their calls cross zones", () => {
    const p50 = (attempt: Attempt) =>
      simulate(attempt).operations.get("redirect")?.latency.p50 ?? 0;

    expect(p50(spread(3))).toBeGreaterThan(p50(spread(1)) + 0.5);
    expect(p50(sameZone(sameZone(spread(3), "lb--api"), "api--redis"))).toBeLessThan(
      p50(spread(3)),
    );
  });
});
