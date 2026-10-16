import {
  type Attempt,
  applyCommand,
  type Catalog,
  CatalogSchema,
  type CommandArgs,
  createCatalogIndex,
  EnvironmentSchema,
  type Fault,
  FaultSchema,
  WorkloadSchema,
} from "@archdrill/model";
import {
  cacheAsideAttempt,
  createLinkAttempt,
  testCatalog,
  testCatalogIndex,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { NO_TIMEOUT_WAIT_MS } from "./calls";
import { failsOverWithZone, resolveFaultHits, resolveFaults, zoneLoss } from "./faults";
import { simulateEnvironment } from "./simulate";
import { CROSS_ZONE_RTT_MS, SAME_ZONE_RTT_MS } from "./zone-traffic";

const workload = WorkloadSchema.parse({
  operations: {
    redirect: { entity: "Link", classes: [{ id: "live", share: 1 }] },
    "create-link": { entity: "Link", classes: [{ id: "generated", share: 1 }] },
  },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
  replication: { decision: "replication-mode" },
  environments: [{ id: "steady", label: "Steady", rates: { redirect: 1 } }],
});

const fault = (input: unknown): Fault => FaultSchema.parse(input);
const cacheDown = (mode: "crash" | "hang") =>
  fault({ kind: "down", target: { capability: "volatile-kv" }, mode });

function simulate(attempt: Attempt, faults: Fault[], rates: Record<string, number>) {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  return simulateEnvironment(
    workload,
    EnvironmentSchema.parse({ id: "env", label: "Env", rates, faults }),
    { attempt, catalog: testCatalogIndex, problem: testProblem, analysis },
  );
}

function redirects(attempt: Attempt, faults: Fault[] = [], rate = 6000) {
  const metrics = simulate(attempt, faults, { redirect: rate });
  const op = metrics.operations.get("redirect");
  if (!op) throw new Error("no redirect metrics");
  return { metrics, op };
}

function apply<N extends Parameters<typeof applyCommand>[1]>(
  attempt: Attempt,
  name: N,
  args: CommandArgs<N>,
): Attempt {
  return applyCommand(attempt, name, args).attempt;
}

const policy = (attempt: Attempt, args: Omit<CommandArgs<"setConnectionPolicy">, "id">) =>
  apply(attempt, "setConnectionPolicy", { id: "api--redis", ...args });

describe("resolveFaults", () => {
  const effect = (attempt: Attempt, f: Fault, id: string) =>
    resolveFaults([f], attempt, testCatalogIndex).get(id);

  it("lets replicas absorb a lost node", () => {
    const lost = effect(
      cacheAsideAttempt(),
      fault({ kind: "down", target: { kind: "cache" }, scope: "one-node" }),
      "redis",
    );

    expect(lost).toMatchObject({ failRead: 0, readCapacity: 0.5, writeCapacity: 1 });
  });

  it("loses a shard's keys when the node had no replica", () => {
    const sharded = apply(cacheAsideAttempt(), "updateComponent", {
      id: "redis",
      replicas: 1,
      shards: 4,
    });

    const lost = effect(
      sharded,
      fault({ kind: "down", target: { kind: "cache" }, scope: "one-node" }),
      "redis",
    );

    expect(lost).toMatchObject({
      failRead: 0.25,
      failWrite: 0.25,
      readCapacity: 0.75,
      writeCapacity: 0.75,
    });
  });

  it("fails writes but not reads while a replicated primary fails over", () => {
    const failover = fault({ kind: "failover", target: { holds: "Link" } });

    expect(effect(cacheAsideAttempt(), failover, "db")).toMatchObject({
      failRead: 0,
      failWrite: 1,
      hang: true,
    });
  });

  it("keeps a store's write capacity when it loses a replica", () => {
    const lost = effect(
      cacheAsideAttempt(),
      fault({ kind: "down", target: { holds: "Link" }, scope: "one-node" }),
      "db",
    );
    const service = effect(
      cacheAsideAttempt(),
      fault({ kind: "down", target: { kind: "service" }, scope: "one-node" }),
      "api",
    );

    expect(lost).toMatchObject({ readCapacity: 0.5, writeCapacity: 1 });
    expect(service).toMatchObject({ readCapacity: 2 / 3, writeCapacity: 2 / 3 });
  });

  it("assumes two partial faults on one component hit the same part", () => {
    const sharded = apply(cacheAsideAttempt(), "updateComponent", {
      id: "db",
      shards: 4,
      replicas: 1,
    });
    const faults = [
      fault({ kind: "down", target: { holds: "Link" }, scope: "one-shard" }),
      fault({ kind: "failover", target: { holds: "Link" } }),
    ];

    expect(resolveFaults(faults, sharded, testCatalogIndex).get("db")).toMatchObject({
      failRead: 0.25,
      failWrite: 0.25,
    });
  });

  it("finds the handler of an operation", () => {
    const crash = fault({ kind: "down", target: { handlerOf: "redirect" }, scope: "one-node" });

    expect([...resolveFaults([crash], cacheAsideAttempt(), testCatalogIndex).keys()]).toEqual([
      "api",
    ]);
  });
});

describe("a lost zone", () => {
  const zoneDown = fault({ kind: "zone-down" });
  const effects = (attempt: Attempt, catalog = testCatalogIndex) =>
    resolveFaults([zoneDown], attempt, catalog);
  const spread = (id: string, changes: Omit<CommandArgs<"updateComponent">, "id">) =>
    apply(cacheAsideAttempt(), "updateComponent", { id, ...changes });

  /** The test catalog with Cassandra's reads and writes at quorum, and a Cassandra cluster. */
  function withQuorumStore(replicas: number, zones: number, shards = 1) {
    const copy: Catalog = JSON.parse(JSON.stringify(testCatalog));
    const kind = copy.kinds.find((k) => k.id === "wide-column-db");
    if (!kind) throw new Error("no wide-column kind in the test catalog");
    kind.quorum = true;
    const attempt = apply(cacheAsideAttempt(), "addComponent", {
      id: "stats",
      kind: "wide-column-db",
      flavor: "cassandra",
      label: "Stats",
      replicas,
      position: { x: 0, y: 0 },
    });
    return {
      catalog: createCatalogIndex(CatalogSchema.parse(copy)),
      attempt: apply(attempt, "updateComponent", { id: "stats", shards, zones }),
    };
  }

  it("takes down a component whose instances all sit in the zone", () => {
    expect(effects(cacheAsideAttempt()).get("api")).toMatchObject({
      failRead: 1,
      failWrite: 1,
      labels: ["down: every instance was in the lost zone"],
    });
  });

  it("leaves managed components and clients alone", () => {
    const lost = effects(cacheAsideAttempt());

    expect(lost.get("lb")).toMatchObject({ failRead: 0, readCapacity: 1, labels: [] });
    expect(lost.has("client")).toBe(false);
  });

  it("costs a spread fleet the zone's share of its instances", () => {
    const lost = effects(spread("api", { zones: 3 })).get("api");

    expect(lost?.failRead).toBe(0);
    expect(lost?.readCapacity).toBeCloseTo(2 / 3, 9);
    expect(lost?.writeCapacity).toBeCloseTo(2 / 3, 9);
  });

  it("keeps a store's writes once the primary in the lost zone has failed over", () => {
    expect(effects(spread("db", { zones: 2 })).get("db")).toMatchObject({
      failRead: 0,
      failWrite: 0,
      readCapacity: 0.5,
      writeCapacity: 1,
    });
  });

  it("loses the keys of shards whose only instance was in the zone", () => {
    const shards = spread("redis", { replicas: 1, shards: 4, zones: 3 });

    expect(effects(shards).get("redis")).toMatchObject({ failRead: 0.5, readCapacity: 0.5 });
  });

  it("stops a quorum store when the zone held a majority of its replicas", () => {
    const twoZones = withQuorumStore(3, 2);
    const threeZones = withQuorumStore(3, 3);

    expect(effects(twoZones.attempt, twoZones.catalog).get("stats")).toMatchObject({
      failRead: 1,
      labels: ["down: the lost zone held 2 of its 3 replicas, a majority"],
    });
    expect(effects(threeZones.attempt, threeZones.catalog).get("stats")?.failRead).toBe(0);
    expect(effects(threeZones.attempt, threeZones.catalog).get("stats")?.readCapacity).toBeCloseTo(
      2 / 3,
      9,
    );
    expect(zoneLoss(component(twoZones.attempt, "stats"), twoZones.catalog).keepsServing).toBe(
      false,
    );
  });

  it("balances shards over zones, so a zone holds a majority of some shards only", () => {
    // Shard 1 sits in zones A, B, A and shard 2 in B, A, B: losing A stops shard 1 only.
    const cluster = withQuorumStore(3, 2, 2);

    expect(effects(cluster.attempt, cluster.catalog).get("stats")).toMatchObject({
      failRead: 0.5,
      readCapacity: 0.5,
      writeCapacity: 0.5,
      labels: ["down: the lost zone held a majority of the replicas of 1 of 2 shards"],
    });
  });

  it("keeps every shard of a cache whose replicas are spread, losing a zone's share", () => {
    const lost = effects(spread("redis", { shards: 3, replicas: 2, zones: 3 })).get("redis");

    expect(lost?.failRead).toBe(0);
    expect(lost?.readCapacity).toBeCloseTo(2 / 3, 9);
  });

  it("spreads primaries over the zones when shards have a replica in every zone", () => {
    // Four shards of three replicas: shard s has its primary in zone s mod 3.
    const db = spread("db", { shards: 4, replicas: 3, zones: 3 });
    const component = db.architecture.components.find((c) => c.id === "db");
    if (!component) throw new Error("no db");

    const failing = resolveFaultHits(
      [{ fault: zoneDown, component, failingOver: true }],
      testCatalogIndex,
    ).get("db");

    // Zone A holds the primaries of two shards of four.
    expect(failing).toMatchObject({ failRead: 0, failWrite: 0.5 });
    expect(failing?.labels).toContain("2 of 4 primaries failing over; writes to them fail");
    expect(effects(db).get("db")).toMatchObject({ failRead: 0, failWrite: 0 });
  });

  it("fails over only the stores whose primary the lost zone held", () => {
    // One shard over two of three zones: the zone holding the primary is the one lost.
    const pair = spread("db", { replicas: 2, zones: 2 });
    const inOneZone = cacheAsideAttempt();
    const db = (attempt: Attempt) => component(attempt, "db");

    expect(failsOverWithZone(db(pair), testCatalogIndex)).toBe(true);
    expect(failsOverWithZone(db(inOneZone), testCatalogIndex)).toBe(false);
    expect(failsOverWithZone(component(pair, "api"), testCatalogIndex)).toBe(false);
  });

  it("stops a quorum store of two replicas when it loses one node", () => {
    const pair = withQuorumStore(2, 2);
    const nodeDown = fault({ kind: "down", target: { kind: "wide-column-db" }, scope: "one-node" });

    expect(resolveFaults([nodeDown], pair.attempt, pair.catalog).get("stats")).toMatchObject({
      failRead: 1,
    });
  });

  it("is survived with the instances that ran before it, not new ones (static stability)", () => {
    const autoscaled = apply(spread("api", { replicas: 3, zones: 3 }), "setAutoscale", {
      id: "api",
      autoscale: { max: 100, targetUtilization: 0.6 },
    });
    // Retries make the engine solve again from cold caches, from the same instances.
    const fleet = apply(autoscaled, "setConnectionPolicy", { id: "api--db", retries: 2 });
    const crash = fault({ kind: "down", target: { kind: "service" }, scope: "one-node" });

    const healthy = redirects(fleet, [], 60_000).metrics.components.get("api");
    const zoneLost = redirects(fleet, [zoneDown], 60_000).metrics;
    const nodeLost = redirects(fleet, [crash], 60_000).metrics.components.get("api");

    const running = healthy?.instances ?? 0;
    // Instances are dealt over the three zones in turn, so the first zone holds the most.
    const left = running - Math.ceil(running / 3);
    expect(zoneLost.components.get("api")?.instances).toBe(running);
    expect(zoneLost.components.get("api")?.utilization).toBeCloseTo(
      ((healthy?.utilization ?? 0) * running) / left,
      2,
    );
    expect(zoneLost.metastable).toEqual([]);
    // Without a lost zone, the autoscaler has replaced the lost node.
    expect(nodeLost?.utilization).toBeLessThan(0.61);
  });
});

function component(attempt: Attempt, id: string) {
  const found = attempt.architecture.components.find((c) => c.id === id);
  if (!found) throw new Error(`no component ${id}`);
  return found;
}

describe("faults and connection policies", () => {
  it("serves redirects from the store while the cache is down", () => {
    const { metrics, op } = redirects(cacheAsideAttempt(), [cacheDown("crash")]);

    expect(op.successRate).toBeCloseTo(1, 9);
    expect(metrics.components.get("db")?.readLoad).toBeCloseTo(6000, 6);
    expect(metrics.components.get("redis")?.faults).toEqual(["down"]);
  });

  it("makes every request wait for the client default when a cache hangs and nobody set a timeout", () => {
    const { op } = redirects(cacheAsideAttempt(), [cacheDown("hang")]);

    expect(op.latency.p50).toBeGreaterThan(NO_TIMEOUT_WAIT_MS);
  });

  it("bounds the damage with a timeout, and removes it with a circuit breaker", () => {
    const bounded = redirects(policy(cacheAsideAttempt(), { timeoutMs: 50 }), [cacheDown("hang")]);
    const breaker = redirects(
      policy(cacheAsideAttempt(), { timeoutMs: 50, circuitBreaker: true }),
      [cacheDown("hang")],
    );

    // The lookup and the population both wait out the timeout: two × 50 ms.
    expect(bounded.op.latency.p50).toBeGreaterThan(100);
    expect(bounded.op.latency.p99).toBeLessThan(120);
    expect(breaker.op.latency.p99).toBeLessThan(20);
    expect(breaker.metrics.calls.get("api--redis")?.shortCircuit).toBeCloseTo(1, 6);
  });

  it("multiplies the load on an overloaded store with retries", () => {
    const big = apply(cacheAsideAttempt(), "updateComponent", { id: "api", replicas: 40 });
    const retrying = apply(big, "setConnectionPolicy", { id: "api--db", retries: 3 });

    const plain = redirects(big, [cacheDown("crash")], 60_000).metrics.components.get("db");
    const amplified = redirects(retrying, [cacheDown("crash")], 60_000).metrics.components.get(
      "db",
    );

    expect(plain?.retryLoad).toBe(0);
    expect(amplified?.readLoad).toBeGreaterThan(1.5 * (plain?.readLoad ?? 0));
    expect(amplified?.retryLoad).toBeGreaterThan(0.3 * (amplified?.readLoad ?? 0));
  });

  it("caps the load a dependency sees with a bulkhead", () => {
    const big = apply(cacheAsideAttempt(), "updateComponent", { id: "api", replicas: 40 });
    const guarded = apply(big, "setConnectionPolicy", { id: "api--db", maxRps: 15_000 });

    const { metrics, op } = redirects(guarded, [cacheDown("crash")], 60_000);

    expect(metrics.components.get("db")?.readLoad).toBeCloseTo(15_000, -2);
    expect(metrics.components.get("db")?.utilization).toBeLessThan(1);
    expect(metrics.calls.get("api--db")?.shed).toBeCloseTo(0.75, 2);
    expect(op.successRate).toBeCloseTo(0.25, 2);
  });

  it("fails creates while the primary fails over, and keeps redirects working", () => {
    const failover = fault({ kind: "failover", target: { holds: "Link" }, mode: "crash" });

    const metrics = simulate(createLinkAttempt("kgs", 1000), [failover], {
      redirect: 1000,
      "create-link": 100,
    });

    expect(metrics.operations.get("create-link")?.successRate).toBeCloseTo(0, 6);
    expect(metrics.operations.get("redirect")?.successRate).toBeCloseTo(1, 6);
  });

  it("slows writes by waiting for replicas under semi-synchronous replication", () => {
    const mean = (mode: string, zones: number) => {
      const spread = apply(createLinkAttempt("kgs", 1000), "updateComponent", { id: "db", zones });
      const attempt = apply(spread, "setDecision", {
        decision: "replication-mode",
        option: mode,
      });
      return (
        simulate(attempt, [], { "create-link": 100 }).operations.get("create-link")?.latency.mean ??
        0
      );
    };

    // A replica in another zone is a millisecond away; waiting for all of them adds their disks.
    expect(mean("semi-sync", 2) - mean("async", 2)).toBeCloseTo(CROSS_ZONE_RTT_MS, 1);
    expect(mean("sync", 2) - mean("async", 2)).toBeCloseTo(2 * CROSS_ZONE_RTT_MS, 1);
    // Replicas in the primary's zone answer within a tenth of a millisecond, and share its fate.
    expect(mean("semi-sync", 1) - mean("async", 1)).toBeCloseTo(SAME_ZONE_RTT_MS, 2);
  });

  it("finds the overloaded state aggressive retries can get stuck in", () => {
    const big = apply(cacheAsideAttempt(), "updateComponent", { id: "api", replicas: 80 });
    const hammer = apply(big, "setConnectionPolicy", {
      id: "api--db",
      timeoutMs: 200,
      retries: 10,
      backoff: "none",
    });

    // Warm, the store sees only misses; cold, it sees all 200,000 reads a second.
    const healthy = redirects(big, [], 200_000).metrics;
    const stuck = redirects(hammer, [], 200_000).metrics;

    expect(healthy.metastable).toEqual([]);
    expect(stuck.components.get("db")?.utilization).toBeLessThan(1);
    expect(stuck.metastable.map((c) => c.componentId)).toEqual(["db"]);
    expect(stuck.metastable[0]?.retryLoad).toBeGreaterThan(0.5 * (stuck.metastable[0]?.load ?? 0));
  });
});
