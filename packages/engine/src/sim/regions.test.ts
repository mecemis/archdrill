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
  CROSS_REGION_RTT_MS,
  CROSS_REGION_USD_PER_GB,
  crossRegionShare,
  HEALTH_CHECK_DETECTION_SEC,
  REGION_DNS_FAILOVER_SEC,
  regionLoss,
  standbyCosts,
  standbyStartsCold,
  takesClients,
  withActiveStandby,
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

describe("both regions taking traffic", () => {
  const twoRegions = WorkloadSchema.parse({
    ...workload,
    regionMode: { decision: "region-mode" },
  });
  const decided = (attempt: Attempt, mode: string) =>
    applyCommand(attempt, "setDecision", { decision: "region-mode", option: mode }).attempt;
  const active = (attempt: Attempt) =>
    decided(withStandby(attempt, everyRegional), "active-active");
  const run = (attempt: Attempt, faults: unknown[] = []) =>
    simulateEnvironment(
      twoRegions,
      EnvironmentSchema.parse({ id: "env", label: "Env", rates: { redirect: 6000 }, faults }),
      context(attempt),
    );

  it("runs both regions' copies, doubling what a placed component has", () => {
    const doubled = withActiveStandby(withStandby(cacheAsideAttempt(), ["api", "db"]), catalog);
    const replicas = (id: string) =>
      doubled.architecture.components.find((c) => c.id === id)?.replicas;

    expect(replicas("api")).toBe(6);
    expect(replicas("db")).toBe(4);
    // Redis has no standby copy here, and the ALB is managed.
    expect(replicas("redis")).toBe(2);
  });

  it("carries the load on both regions' instances, and bills them as its own", () => {
    const passive = run(decided(withStandby(cacheAsideAttempt(), everyRegional), "active-passive"));
    const both = run(active(cacheAsideAttempt()));
    const api = (m: typeof both) => m.components.get("api");

    expect(api(both)?.utilization).toBeCloseTo((api(passive)?.utilization ?? 0) / 2, 6);
    expect(api(both)?.costBreakdown.standbyRegion).toBe(0);
    expect(api(both)?.monthlyCost).toBeCloseTo(api(passive)?.monthlyCost ?? 0, 6);
  });

  it("is back to one region's copies once a region is lost", () => {
    const lost = run(active(cacheAsideAttempt()), [{ kind: "region-down" }]);

    expect(lost.components.get("api")?.instances).toBe(3);
  });

  it("sends half the calls across regions to what runs in the primary region only, or to a single writer's primary", () => {
    const attempt = withStandby(createLinkAttempt("kgs", 1000), ["api", "redis", "db"]);
    const analysis = analyzeAttempt(attempt, { catalog, problem: testProblem });
    const step = (op: string, action: string) => {
      const found = analysis.operations
        .get(op)
        ?.paths.flatMap((p) => p.steps)
        .find((s) => s.kind === "call" && s.action === action);
      if (found?.kind !== "call") throw new Error(`no ${action}`);
      return found;
    };

    expect(crossRegionShare(step("redirect", "store.read"), attempt, catalog)).toBe(0);
    expect(crossRegionShare(step("create-link", "store.insertIfAbsent"), attempt, catalog)).toBe(
      0.5,
    );
    // KGS runs in the primary region only.
    expect(crossRegionShare(step("create-link", "ids.allocate"), attempt, catalog)).toBe(0.5);
    expect(
      crossRegionShare({ ...step("redirect", "store.read"), consistent: true }, attempt, catalog),
    ).toBe(0.5);
    expect(crossRegionShare(step("redirect", "cache.get"), attempt, catalog)).toBe(0);
  });

  it("sends a write to the home region across, even to a store that takes writes in both", () => {
    const base = withStandby(createLinkAttempt("kgs", 1000), ["api", "db"]);
    const dynamo: Attempt = {
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
    const analysis = analyzeAttempt(dynamo, { catalog, problem: testProblem });
    const insert = analysis.operations
      .get("create-link")
      ?.paths.flatMap((p) => p.steps)
      .find((s) => s.kind === "call" && s.action === "store.insertIfAbsent");
    if (insert?.kind !== "call") throw new Error("no insert");

    expect(crossRegionShare(insert, dynamo, catalog)).toBe(0);
    expect(crossRegionShare({ ...insert, homeRegion: true }, dynamo, catalog)).toBe(0.5);
  });

  it("does nothing with the home region while only one region takes traffic", () => {
    const creates = WorkloadSchema.parse({
      operations: { "create-link": { entity: "Link", classes: [{ id: "generated", share: 1 }] } },
      keys: { Link: { existing: { distribution: "zipf", s: 1, population: 1e6 } } },
      regionMode: { decision: "region-mode" },
      environments: [{ id: "env", label: "Env", rates: { "create-link": 100 } }],
    });
    const passive = decided(
      withStandby(createLinkAttempt("kgs", 1000), everyRegional),
      "active-passive",
    );
    const home = applyCommand(passive, "updateStep", {
      operation: "create-link",
      stepId: "insert",
      homeRegion: true,
    }).attempt;
    const [env] = creates.environments;
    if (!env) throw new Error("no environment");
    const p99 = (attempt: Attempt) =>
      simulateEnvironment(creates, env, context(attempt)).operations.get("create-link")?.latency
        .p99;

    expect(p99(home)).toBe(p99(passive));
  });

  it("leaves the local half of requests fast and adds the round trip to the other half", () => {
    const local = run(decided(withStandby(cacheAsideAttempt(), everyRegional), "active-passive"));
    const consistentReads = applyCommand(active(cacheAsideAttempt()), "updateStep", {
      operation: "redirect",
      stepId: "read",
      consistent: true,
    }).attempt;
    const crossing = run(consistentReads);
    const p50 = (m: typeof local) => m.operations.get("redirect")?.latency.p50 ?? 0;
    const p99 = (m: typeof local) => m.operations.get("redirect")?.latency.p99 ?? 0;

    // Cache hits never cross; a consistent read on a miss from the other region does.
    expect(p50(crossing)).toBeCloseTo(p50(local), 0);
    expect(p99(crossing)).toBeGreaterThan(p99(local) + CROSS_REGION_RTT_MS / 2);
  });

  it("fails only the lost region's clients until DNS moves them, with the other region's cache warm", () => {
    const timeline = TimelineSchema.parse({
      id: "t",
      label: "Region lost",
      durationSec: 300,
      stepSec: 10,
      rates: { redirect: 6000 },
      events: [{ kind: "fault", at: 30, fault: { kind: "region-down" } }],
    });
    const result = simulateTimeline(twoRegions, timeline, context(active(cacheAsideAttempt())));
    const success = result.operations.get("redirect")?.successRate;
    const back = 30 + REGION_DNS_FAILOVER_SEC;

    expect(at(result.times, success, back - 10)).toBeCloseTo(0.5, 2);
    expect(at(result.times, success, back + 30)).toBeGreaterThan(0.99);
    expect(result.marks.filter((m) => m.kind === "restart")).toEqual([]);
    // The surviving region's store copy is promoted before it takes writes.
    const db = result.components.get("db")?.faults;
    expect(db?.[result.times.indexOf(40)]).toEqual([
      "standby copy being promoted; writes fail, reads continue",
    ]);
  });

  it("fails a request once, at the first way into the region", () => {
    // Clients also call the API directly, but the ALB in front of it is the way in for most.
    const attempt = applyCommand(cacheAsideAttempt(), "addConnection", {
      from: "client",
      to: "api",
    }).attempt;
    const component = (id: string) => {
      const c = attempt.architecture.components.find((x) => x.id === id);
      if (!c) throw new Error(id);
      return c;
    };

    expect(takesClients(component("lb"), attempt, catalog)).toBe(true);
    expect(takesClients(component("api"), attempt, catalog)).toBe(false);
  });

  it("keeps the half of an autoscaled fleet that ran in the other region", () => {
    const scaled = applyCommand(cacheAsideAttempt(), "setAutoscale", {
      id: "api",
      autoscale: { max: 30, targetUtilization: 0.2 },
    }).attempt;
    const timeline = TimelineSchema.parse({
      id: "t",
      label: "Region lost",
      durationSec: 120,
      stepSec: 10,
      rates: { redirect: 6000 },
      events: [{ kind: "fault", at: 30, fault: { kind: "region-down" } }],
    });
    const result = simulateTimeline(twoRegions, timeline, context(active(scaled)));
    const instances = result.components.get("api")?.instances;

    expect(at(result.times, instances, 30)).toBeCloseTo(at(result.times, instances, 20) / 2, 0);
  });
});
