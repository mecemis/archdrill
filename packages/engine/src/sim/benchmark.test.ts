import { type Calibration, CalibrationSchema } from "@archdrill/model";
import { testCatalogIndex } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import {
  benchmarkedProfile,
  CALIBRATION_TOLERANCE,
  closedLoop,
  openLoop,
  replayCalibration,
} from "./benchmark";
import { SAME_ZONE_RTT_MS } from "./zone-traffic";

// The test catalog's Redis: 150,000 reads and 120,000 writes a second, 0.5 ms per command.
const calibration = (changes: Partial<Calibration> = {}): Calibration =>
  CalibrationSchema.parse({
    id: "redis-bench",
    title: "Redis on one node",
    source: "bench",
    component: { kind: "cache", flavor: "redis", size: "m" },
    setup: "One node.",
    network: "zone",
    reads: 1,
    runs: [{ clients: 1, latencyMs: 0.6 }],
    ...changes,
  });

const profile = benchmarkedProfile(calibration(), testCatalogIndex);

describe("closed-loop replay", () => {
  it("gives one client the service time plus the round trip, with no queueing", () => {
    const run = closedLoop(profile, 1, SAME_ZONE_RTT_MS, 1);

    expect(run.latencyMs).toBeCloseTo(0.5 + SAME_ZONE_RTT_MS, 6);
    expect(run.throughput).toBeCloseTo(1000 / 0.6, 3);
  });

  it("saturates at the size's capacity, however many clients wait", () => {
    const run = closedLoop(profile, 1, SAME_ZONE_RTT_MS, 10_000);

    expect(run.throughput).toBeLessThanOrEqual(150_000);
    expect(run.throughput).toBeGreaterThan(0.97 * 150_000);
    // Little's law: the clients are all waiting somewhere.
    expect(run.latencyMs).toBeCloseTo((10_000 * 1000) / run.throughput, 6);
  });

  it("serves more as clients are added, until the queue takes over", () => {
    const throughputs = [1, 10, 50, 100, 500, 5000].map(
      (clients) => closedLoop(profile, 1, SAME_ZONE_RTT_MS, clients).throughput,
    );

    for (let i = 1; i < throughputs.length; i++) {
      expect(throughputs[i]).toBeGreaterThanOrEqual(throughputs[i - 1] as number);
    }
  });

  it("weighs writes by their own capacity", () => {
    const writes = closedLoop(profile, 0, SAME_ZONE_RTT_MS, 10_000);

    expect(writes.throughput).toBeLessThanOrEqual(120_000);
    expect(writes.throughput).toBeGreaterThan(0.97 * 120_000);
  });
});

describe("open-loop replay", () => {
  it("puts the median near the service time plus the round trip when the node is idle", () => {
    const latency = openLoop(profile, 1, SAME_ZONE_RTT_MS, 100);

    expect(latency.mean).toBeCloseTo(0.5 + SAME_ZONE_RTT_MS, 3);
    expect(latency.p50).toBeLessThan(latency.mean);
    expect(latency.p50).toBeGreaterThan(0.8 * latency.mean);
  });

  it("adds queueing as the rate nears capacity", () => {
    const idle = openLoop(profile, 1, SAME_ZONE_RTT_MS, 1000).p50;
    const busy = openLoop(profile, 1, SAME_ZONE_RTT_MS, 145_000).p50;

    expect(busy).toBeGreaterThan(idle);
  });
});

describe("benchmark work", () => {
  it("replays lighter requests as more of them, each shorter, with as many in service", () => {
    const light = benchmarkedProfile(
      calibration({ work: { ratio: 6, why: "Real commands are heavier." } }),
      testCatalogIndex,
    );

    expect(light.readCapacity).toBe(6 * profile.readCapacity);
    expect(light.writeCapacity).toBe(6 * profile.writeCapacity);
    expect(light.serviceTimeMs).toBeCloseTo(profile.serviceTimeMs / 6, 9);
    expect(light.servers).toBe(profile.servers);
  });

  it("builds the benchmark's replicas: reads spread over them, writes go to the primary", () => {
    const three = benchmarkedProfile(
      calibration({ component: { kind: "cache", flavor: "redis", size: "m", replicas: 3 } }),
      testCatalogIndex,
    );

    expect(three.readCapacity).toBe(3 * 150_000);
    expect(three.writeCapacity).toBe(120_000);
  });
});

describe("replayCalibration", () => {
  it("compares only what each run measured, and flags runs beyond the tolerance", () => {
    const runs = replayCalibration(
      calibration({
        runs: [
          { clients: 1, latencyMs: 0.6 },
          { clients: 10_000, throughput: 100_000 },
          { rate: 1000, p50Ms: 0.58 },
        ],
      }),
      testCatalogIndex,
    );

    expect(runs.map((r) => Object.keys(r.engine))).toEqual([
      ["latencyMs"],
      ["throughput"],
      ["p50Ms"],
    ]);
    expect(runs[0]?.within).toBe(true);
    expect(runs[1]?.error).toBeGreaterThan(CALIBRATION_TOLERANCE);
    expect(runs[1]?.within).toBe(false);
    expect(runs[2]?.within).toBe(true);
  });

  it("takes the worse of throughput and latency for a run that measured both", () => {
    const [run] = replayCalibration(
      calibration({ runs: [{ clients: 1, throughput: 1000 / 0.6, latencyMs: 0.3 }] }),
      testCatalogIndex,
    );

    expect(run?.error).toBeCloseTo(1, 6);
  });
});
