import {
  type Attempt,
  type Catalog,
  CatalogSchema,
  createCatalogIndex,
  EnvironmentSchema,
  WorkloadSchema,
} from "@archdrill/model";
import { cacheAsideAttempt, testCatalog, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import type { CallPathStep, Path } from "../paths/types";
import { type ComponentProfile, SECONDS_PER_MONTH } from "./capacity";
import { simulateEnvironment } from "./simulate";
import { stepCosts } from "./step-costs";
import { networkShare, shardUtilizations } from "./summary";

type FlavorEdit = (flavor: Catalog["kinds"][number]["flavors"][number]) => void;

/** The test catalog with one flavor changed. */
function catalogWith(kind: string, edit: FlavorEdit) {
  const copy: Catalog = JSON.parse(JSON.stringify(testCatalog));
  const flavor = copy.kinds.find((k) => k.id === kind)?.flavors[0];
  if (!flavor) throw new Error(`no ${kind} in the test catalog`);
  edit(flavor);
  return createCatalogIndex(CatalogSchema.parse(copy));
}

/** Postgres metered like DynamoDB, with units small enough that a 500-byte link takes several. */
const metered = catalogWith("relational-db", (f) => {
  f.requestUnits = { per: "item", readBytes: 128, writeBytes: 128, readUnits: 0.5 };
  f.requestCost = { readPerMillion: 1, writePerMillion: 1 };
});
const plain = createCatalogIndex(testCatalog);

function simulate(
  catalog: ReturnType<typeof createCatalogIndex>,
  exists: boolean,
  attempt: Attempt = cacheAsideAttempt(),
) {
  const environment = EnvironmentSchema.parse({
    id: "steady",
    label: "Steady",
    rates: { redirect: 6000 },
    faults: [],
  });
  const workload = WorkloadSchema.parse({
    operations: { redirect: { entity: "Link", classes: [{ id: "all", share: 1, exists }] } },
    keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e10 } } },
    environments: [environment],
  });
  const analysis = analyzeAttempt(attempt, { catalog, problem: testProblem });
  return simulateEnvironment(workload, environment, {
    attempt,
    catalog,
    problem: testProblem,
    analysis,
  });
}

describe("stores that meter by item size", () => {
  it("count a found item's read in units of its size: 500 bytes at 128 a half unit is 2", () => {
    const requests = simulate(plain, true).components.get("db")?.readLoad ?? 0;
    const units = simulate(metered, true).components.get("db")?.readLoad ?? 0;

    expect(requests).toBeGreaterThan(0);
    expect(units).toBeCloseTo(2 * requests, 6);
  });

  it("count a read of a missing item as the smallest read", () => {
    const requests = simulate(plain, false).components.get("db")?.readLoad ?? 0;
    const units = simulate(metered, false).components.get("db")?.readLoad ?? 0;

    expect(units).toBeCloseTo(0.5 * requests, 6);
  });

  it("bill the units, not the requests", () => {
    const db = simulate(metered, true).components.get("db");

    expect(db?.costBreakdown.requests).toBeCloseTo(
      ((db?.readLoad ?? 0) + (db?.writeLoad ?? 0)) * (SECONDS_PER_MONTH / 1e6),
      6,
    );
  });
});

describe("network bandwidth", () => {
  // Two Redis replicas that sustain 4 Mbit/s each: 1 MB/s between them.
  const narrow = catalogWith("cache", (f) => {
    const size = f.sizes.m;
    if (size) size.networkGbps = 0.004;
  });

  it("fills with the values reads return, and limits the node before its CPU does", () => {
    const wide = simulate(plain, true).components.get("redis");
    const redis = simulate(narrow, true).components.get("redis");
    const cache = simulate(narrow, true).caches.find((c) => c.componentId === "redis");

    expect(wide?.networkUtilization).toBe(0);
    expect(redis?.bytesOut).toBeCloseTo((cache?.lookupRate ?? 0) * (cache?.hitRatio ?? 0) * 500, 0);
    expect(redis?.networkUtilization).toBeGreaterThan(1);
    expect(redis?.utilization).toBeCloseTo(redis?.networkUtilization ?? 0, 6);
    expect(redis?.dropRate).toBeGreaterThan(0);
  });
});

describe("a hot key's share of the network", () => {
  const profile = {
    sharded: true,
    shards: 4,
    readCapacity: 1e9,
    writeCapacity: 1e9,
    outboundBytesPerSec: 400,
    perKeyWriteCapacity: Number.POSITIVE_INFINITY,
    heldConnections: 0,
    connectionCapacity: Number.POSITIVE_INFINITY,
  } as ComponentProfile;

  it("lands on the shard that holds the key, each resource counted on its own", () => {
    const load = { read: 10, write: 0, bytes: 200 };
    const hot = { read: 5, write: 0, bytes: 100 };

    expect(networkShare(load, profile)).toBeCloseTo(0.5, 9);
    // Ordinary keys: (200 − 100) / 400. The hot shard: 4 × 100 / 400 + that.
    expect(shardUtilizations(load, hot, profile)).toEqual({ normal: 0.25, hottest: 1.25 });
  });
});

describe("stores that meter a request's payload", () => {
  const queueLike = catalogWith("cache", (f) => {
    f.requestUnits = { per: "request", readBytes: 1024, writeBytes: 1024, readUnits: 1 };
  });
  const attempt = cacheAsideAttempt();
  const ctx = {
    attempt,
    catalog: queueLike,
    problem: testProblem,
    analysis: analyzeAttempt(attempt, { catalog: queueLike, problem: testProblem }),
  };
  const step = (changes: Partial<CallPathStep>): CallPathStep => ({
    kind: "call",
    stepId: "populate",
    target: "redis",
    targetKind: "cache",
    connectionId: null,
    action: "cache.set",
    entity: "Link",
    ttlSec: 60,
    batchSize: undefined,
    event: undefined,
    outcome: "ok",
    ...changes,
  });
  const costOf = (s: CallPathStep) => stepCosts([{ steps: [s] } as unknown as Path], ctx)[0]?.[0];

  it("counts a batch's whole payload once, not each item", () => {
    expect(costOf(step({}))).toMatchObject({ units: 1, perRequest: true, perItem: false });
    // Ten 500-byte links are 5,000 bytes: five 1 KB units for the one request.
    expect(costOf(step({ batchSize: 10 }))?.units).toBe(5);
  });
});
