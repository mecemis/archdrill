import {
  type Attempt,
  applyCommand,
  type CatalogIndex,
  createCatalogIndex,
  EnvironmentSchema,
  FaultSchema,
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
import { faultedComponents } from "./faults";
import {
  CROSS_REGION_USD_PER_GB,
  HEALTH_CHECK_DETECTION_SEC,
  REGION_DNS_FAILOVER_SEC,
  regionLoss,
  standbyCosts,
  standbyStartsCold,
} from "./regions";
import { simulateEnvironment } from "./simulate";
import { simulateTimeline } from "./timeline";

/** The test catalog with Postgres promoted in three minutes and Redis kept filled across regions. */
const catalog: CatalogIndex = createCatalogIndex({
  ...testCatalog,
  kinds: testCatalog.kinds.map((kind) => ({
    ...kind,
    flavors: kind.flavors.map((f) => (f.id === "postgres" ? { ...f, regionFailoverSec: 180 } : f)),
  })),
});

const workload = WorkloadSchema.parse({
  operations: { redirect: { entity: "Link", classes: [{ id: "live", share: 1 }] } },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
  environments: [{ id: "steady", label: "Steady", rates: { redirect: 6000 } }],
});

const regionDown = FaultSchema.parse({ kind: "region-down" });

function context(attempt: Attempt, index: CatalogIndex = catalog) {
  const analysis = analyzeAttempt(attempt, { catalog: index, problem: testProblem });
  return { attempt, catalog: index, problem: testProblem, analysis };
}

function simulate(attempt: Attempt, faults: unknown[] = []) {
  return simulateEnvironment(
    workload,
    EnvironmentSchema.parse({ id: "env", label: "Env", rates: { redirect: 6000 }, faults }),
    context(attempt),
  );
}

/** Gives the listed components a standby copy in a second region. */
function withStandby(attempt: Attempt, ids: readonly string[]): Attempt {
  return ids.reduce(
    (a, id) => applyCommand(a, "updateComponent", { id, regions: 2 }).attempt,
    attempt,
  );
}

const everyRegional = ["lb", "api", "redis", "db"];

function regionLossOverTime(attempt: Attempt, durationSec = 400) {
  const timeline = TimelineSchema.parse({
    id: "t",
    label: "Region lost",
    durationSec,
    stepSec: 10,
    rates: { redirect: 6000 },
    events: [{ kind: "fault", at: 30, fault: { kind: "region-down" } }],
  });
  return simulateTimeline(workload, timeline, context(attempt));
}

const at = (times: readonly number[], series: readonly number[] | undefined, t: number) =>
  series?.[times.indexOf(t)] ?? Number.NaN;

describe("a lost region", () => {
  it("takes everything that ran only in it", () => {
    const op = simulate(cacheAsideAttempt(), [regionDown]).operations.get("redirect");

    expect(op?.successRate).toBe(0);
  });

  it("leaves clients alone, which are outside the region", () => {
    const hit = faultedComponents(regionDown, cacheAsideAttempt(), catalog).map((c) => c.id);

    expect(hit).toEqual(everyRegional);
  });

  it("is served by the standby copies once the failover has settled", () => {
    const op = simulate(withStandby(cacheAsideAttempt(), everyRegional), [regionDown]).operations;

    expect(op.get("redirect")?.successRate).toBeCloseTo(1, 6);
  });

  it("is survived only by requests whose every component has a standby copy", () => {
    // Without the database, only cache hits still succeed.
    const metrics = simulate(withStandby(cacheAsideAttempt(), ["lb", "api", "redis"]), [
      regionDown,
    ]);
    const success = metrics.operations.get("redirect")?.successRate ?? 0;

    expect(success).toBeGreaterThan(0.5);
    expect(success).toBeLessThan(1);
    expect(metrics.components.get("db")?.faults).toEqual(["down: it ran only in the lost region"]);
  });

  it("says what losing the region does to each component", () => {
    const attempt = withStandby(cacheAsideAttempt(), ["api"]);
    const byId = (id: string) => {
      const c = attempt.architecture.components.find((x) => x.id === id);
      if (!c) throw new Error(id);
      return regionLoss(c, catalog);
    };

    expect(byId("api").keepsServing).toBe(true);
    expect(byId("db")).toEqual({ keepsServing: false, label: "runs only in the primary region" });
    expect(byId("client").keepsServing).toBe(true);
  });
});

describe("the standby region's cost", () => {
  it("bills the standby copy's instances, at an autoscaled fleet's minimum", () => {
    const scaled = applyCommand(cacheAsideAttempt(), "setAutoscale", {
      id: "api",
      autoscale: { max: 30, targetUtilization: 0.2 },
    }).attempt;
    const primary = simulate(scaled).components.get("api");
    const standby = simulate(withStandby(scaled, ["api"])).components.get("api");
    // 3 instances of 0.17 USD an hour, while the primary region runs what the load needs.
    const minimum = 3 * 0.17 * 730;

    expect(primary?.instances).toBeGreaterThan(3);
    expect(standby?.costBreakdown.standbyRegion).toBeCloseTo(minimum, 6);
    expect(standby?.monthlyCost).toBeCloseTo((primary?.monthlyCost ?? 0) + minimum, 6);
  });

  it("bills a store's standby copy and the data replicated to it", () => {
    const db = simulate(withStandby(cacheAsideAttempt(), ["db"])).components.get("db");
    // Two instances of 1.4 USD an hour; redirects write nothing, so nothing is replicated.
    expect(db?.costBreakdown.standbyRegion).toBeCloseTo(2 * 1.4 * 730, 6);
  });

  it("bills a store's standby for every link a create replicates to it", () => {
    const creates = WorkloadSchema.parse({
      operations: { "create-link": { entity: "Link", classes: [{ id: "generated", share: 1 }] } },
      keys: { Link: { existing: { distribution: "zipf", s: 1, population: 1e6 } } },
      environments: [{ id: "env", label: "Env", rates: { "create-link": 1000 } }],
    });
    const attempt = withStandby(createLinkAttempt("kgs", 1000), ["db"]);
    const [env] = creates.environments;
    if (!env) throw new Error("no environment");
    const metrics = simulateEnvironment(creates, env, context(attempt));
    // Each conditional insert sends its 500-byte link, which the standby receives too.
    const written = metrics.zoneTraffic.get("api--db")?.bytesPerSec.write ?? 0;
    const replicated = ((written * 730 * 3600) / 1e9) * CROSS_REGION_USD_PER_GB;

    expect(written).toBeCloseTo(1000 * 500, -2);
    expect(metrics.components.get("db")?.costBreakdown.standbyRegion).toBeCloseTo(
      2 * 1.4 * 730 + replicated,
      6,
    );
  });

  it("bills a cache kept filled across regions for what it replicates, and a cold one for nothing", () => {
    const filled = createCatalogIndex({
      ...testCatalog,
      kinds: testCatalog.kinds.map((kind) => ({
        ...kind,
        flavors: kind.flavors.map((f) =>
          f.id === "redis" ? { ...f, crossRegionReplication: true } : f,
        ),
      })),
    });
    const attempt = withStandby(cacheAsideAttempt(), ["redis"]);
    const env = EnvironmentSchema.parse({ id: "env", label: "Env", rates: { redirect: 6000 } });
    const kept = simulateEnvironment(workload, env, context(attempt, filled));
    const cold = simulateEnvironment(workload, env, context(attempt));
    const fills = kept.zoneTraffic.get("api--redis")?.bytesPerSec.write ?? 0;
    const replicated = ((fills * 730 * 3600) / 1e9) * CROSS_REGION_USD_PER_GB;

    expect(fills).toBeGreaterThan(0);
    expect(kept.components.get("redis")?.costBreakdown.standbyRegion).toBeCloseTo(
      (cold.components.get("redis")?.costBreakdown.standbyRegion ?? 0) + replicated,
      6,
    );
  });
});

describe("standby caches", () => {
  it("start an in-process cache cold with the standby service that holds it", () => {
    const attempt = applyCommand(
      applyCommand(cacheAsideAttempt(), "addComponent", {
        id: "near",
        kind: "near-cache",
        flavor: "lru",
        label: "Near cache",
        position: { x: 0, y: 0 },
      }).attempt,
      "addConnection",
      { from: "api", to: "near" },
    ).attempt;
    const near = attempt.architecture.components.find((c) => c.id === "near");
    if (!near) throw new Error("no near cache");

    expect(standbyStartsCold(near, attempt, catalog)).toBe(false);
    expect(standbyStartsCold(near, withStandby(attempt, ["api"]), catalog)).toBe(true);
  });

  it("start a cache kept filled across regions warm", () => {
    const filled = createCatalogIndex({
      ...testCatalog,
      kinds: testCatalog.kinds.map((kind) => ({
        ...kind,
        flavors: kind.flavors.map((f) =>
          f.id === "redis" ? { ...f, crossRegionReplication: true } : f,
        ),
      })),
    });
    const attempt = withStandby(cacheAsideAttempt(), ["redis"]);
    const redis = attempt.architecture.components.find((c) => c.id === "redis");
    if (!redis) throw new Error("no redis");

    expect(standbyStartsCold(redis, attempt, catalog)).toBe(true);
    expect(standbyStartsCold(redis, attempt, filled)).toBe(false);
  });
});

describe("standbyCosts", () => {
  it("bills a request-billed store for every item batched writes apply in both regions", () => {
    const base = cacheAsideAttempt();
    const attempt: Attempt = {
      ...base,
      architecture: {
        ...base.architecture,
        components: base.architecture.components.map((c) =>
          c.id === "db"
            ? { ...c, kind: "key-value-db", flavor: "dynamodb", size: "on-demand", replicas: 1 }
            : c,
        ),
      },
    };
    const table = withStandby(attempt, ["db"]);
    const write = (n: number) => new Map([["db", { read: 0, write: n }]]);
    // Ten batched calls a second carry 1,000 items each.
    const costs = standbyCosts(table, catalog, new Map(), {
      loads: write(10),
      batchedItems: write(9990),
      transfer: new Map(),
    });

    expect(costs.get("db")).toBeCloseTo((10_000 * 0.625 * 730 * 3600) / 1e6, 6);
  });
});

describe("a lost region over time", () => {
  it("fails every request until DNS sends clients to the standby region", () => {
    const result = regionLossOverTime(withStandby(cacheAsideAttempt(), everyRegional));
    const success = result.operations.get("redirect")?.successRate;
    const back = 30 + REGION_DNS_FAILOVER_SEC;

    expect(at(result.times, success, 20)).toBeCloseTo(1, 6);
    expect(at(result.times, success, back - 10)).toBe(0);
    expect(at(result.times, success, back + 60)).toBeGreaterThan(0.99);
    expect(result.marks).toContainEqual(
      expect.objectContaining({
        at: back,
        kind: "failed-over",
        label: "Clients reach the standby region",
      }),
    );
  });

  it("takes writes on the standby store only once it is promoted", () => {
    const result = regionLossOverTime(withStandby(cacheAsideAttempt(), everyRegional));
    const promoted = 30 + HEALTH_CHECK_DETECTION_SEC + 180;
    const faults = result.components.get("db")?.faults;
    const during = faults?.[result.times.indexOf(promoted - 10)];

    expect(during).toEqual(["standby copy being promoted; writes fail, reads continue"]);
    expect(faults?.[result.times.indexOf(promoted)]).toEqual([]);
    expect(result.marks).toContainEqual(
      expect.objectContaining({ at: promoted, label: "Postgres promoted in the standby region" }),
    );
  });

  it("starts a standby cache empty when nothing kept it filled", () => {
    const result = regionLossOverTime(withStandby(cacheAsideAttempt(), everyRegional));

    expect(result.marks).toContainEqual(
      expect.objectContaining({
        at: 30 + REGION_DNS_FAILOVER_SEC,
        kind: "restart",
        componentIds: ["redis"],
      }),
    );
  });

  it("starts an autoscaled standby fleet at its minimum, and scales it out", () => {
    const scaled = applyCommand(cacheAsideAttempt(), "setAutoscale", {
      id: "api",
      autoscale: { max: 30, targetUtilization: 0.2 },
    }).attempt;
    const result = regionLossOverTime(withStandby(scaled, everyRegional), 600);
    const instances = result.components.get("api")?.instances;
    const back = 30 + REGION_DNS_FAILOVER_SEC;

    expect(at(result.times, instances, 20)).toBeGreaterThan(3);
    // The standby copy runs its minimum from the moment the region is lost.
    expect(at(result.times, instances, 30)).toBe(3);
    expect(at(result.times, instances, back)).toBe(3);
    expect(at(result.times, instances, 600)).toBeGreaterThan(3);
    expect(result.marks.filter((m) => m.kind === "scale-in")).toEqual([]);
  });
});
