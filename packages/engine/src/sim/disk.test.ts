import { type Attempt, applyCommand, EnvironmentSchema, WorkloadSchema } from "@archdrill/model";
import {
  cacheAsideAttempt,
  diskCatalogIndex,
  testCatalogIndex,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateEnvironment } from "./simulate";

/** 200 million links of 500 bytes: 100 GB on each copy, below the striped volume's 400 GiB. */
const workload = WorkloadSchema.parse({
  operations: { redirect: { entity: "Link", classes: [{ id: "live", share: 1 }] } },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
  dataset: { Link: 2e8 },
  environments: [{ id: "steady", label: "Steady", rates: { redirect: 6000 } }],
});

/** Every redirect reaches the database: the cache refuses its connections. */
const cacheDown = [{ kind: "down", target: { capability: "volatile-kv" } }];

function simulate(
  attempt: Attempt,
  { rate = 6000, faults = cacheDown, catalog = diskCatalogIndex } = {},
) {
  const analysis = analyzeAttempt(attempt, { catalog, problem: testProblem });
  return simulateEnvironment(
    workload,
    EnvironmentSchema.parse({ id: "env", label: "Env", rates: { redirect: rate }, faults }),
    { attempt, catalog, problem: testProblem, analysis },
  );
}

const update = (attempt: Attempt, args: Record<string, unknown>) =>
  applyCommand(attempt, "updateComponent", args as never).attempt;

/** Enough API instances that the database, not the service, takes the load. */
const wideApi = () => update(cacheAsideAttempt(), { id: "api", replicas: 10 });

describe("page cache and volume", () => {
  it("reads the pages of what its page cache misses from its volume", () => {
    const db = simulate(cacheAsideAttempt()).components.get("db");
    const hit = db?.disk?.hitRatio ?? 0;

    // 1.45 million keys of 16 KiB fit one copy's 22 GiB: most of the popular links.
    expect(hit).toBeGreaterThan(0.7);
    expect(hit).toBeLessThan(0.9);
    // 3,000 reads a second on each of the two copies, two pages each that miss.
    expect(db?.disk?.readIops).toBeCloseTo(3000 * (1 - hit) * 2, 0);
    // Below 400 GiB a copy has the small volume's 3,000.
    expect(db?.disk?.limit).toBe(3000);
    expect(db?.utilization).toBeCloseTo((db?.disk?.readIops ?? 0) / 3000, 6);
  });

  it("barely hits behind a cache that keeps the popular keys", () => {
    const straight = simulate(cacheAsideAttempt()).components.get("db")?.disk?.hitRatio ?? 0;
    const behind = simulate(cacheAsideAttempt(), { faults: [] }).components.get("db")?.disk;

    expect(behind?.hitRatio).toBeLessThan(0.1);
    expect(behind?.hitRatio).toBeLessThan(straight - 0.6);
  });

  it("adds the reads that miss their pages' time to the store's latency", () => {
    const disk = simulate(cacheAsideAttempt()).components.get("db");
    const memory = simulate(cacheAsideAttempt(), { catalog: testCatalogIndex }).components.get(
      "db",
    );
    const missing = 1 - (disk?.disk?.hitRatio ?? 0);

    expect(memory?.disk).toBeNull();
    // Two 1 ms page reads for the reads that miss, and a little queueing at the volume.
    expect((disk?.latency.mean ?? 0) - (memory?.latency.mean ?? 0)).toBeGreaterThan(missing * 2);
    expect((disk?.latency.mean ?? 0) - (memory?.latency.mean ?? 0)).toBeLessThan(missing * 3);
  });

  it("refuses what its volume cannot read, and takes provisioned I/Os up to its instance's", () => {
    const small = simulate(wideApi(), { rate: 20000 }).components.get("db");
    const provisioned = simulate(update(wideApi(), { id: "db", iops: 12000 }), { rate: 20000 });
    const beyond = simulate(update(wideApi(), { id: "db", iops: 20000 }), { rate: 20000 });
    const db = provisioned.components.get("db");

    // 10,000 reads a second per copy, a fifth of them two pages from a 3,000 I/O volume.
    expect(small?.disk?.utilization).toBeGreaterThan(1);
    expect(small?.dropRate).toBeGreaterThan(0.2);
    expect(db?.disk?.limit).toBe(12000);
    expect(db?.dropRate).toBe(0);
    // The instance sustains 12,000: provisioning more is paid for and unused.
    expect(beyond.components.get("db")?.disk?.limit).toBe(12000);
    expect(db?.costBreakdown.iops).toBe(0);
    expect(beyond.components.get("db")?.costBreakdown.iops).toBeCloseTo(8000 * 0.02 * 2, 6);
    // Provisioning takes a striped volume: the test catalog's 400 GB billed on each copy at least.
    expect(db?.storageGb).toBeCloseTo(400 * 2, 6);
  });

  it("reads a consistent read's pages on the primary's volume alone", () => {
    const eventual = simulate(cacheAsideAttempt()).components.get("db");
    const consistent = simulate(
      applyCommand(cacheAsideAttempt(), "updateStep", {
        operation: "redirect",
        stepId: "read",
        consistent: true,
      }).attempt,
    ).components.get("db");

    // Two copies, one of them the primary: its volume takes every page.
    expect(consistent?.disk?.utilization).toBeCloseTo(2 * (eventual?.disk?.utilization ?? 0), 2);
  });
});
