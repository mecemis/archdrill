import {
  type Catalog,
  CatalogSchema,
  createCatalogIndex,
  EnvironmentSchema,
  type Problem,
  WorkloadSchema,
} from "@archdrill/model";
import { cacheAsideAttempt, testCatalog, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { HOURS_PER_MONTH } from "./capacity";
import { capacityUnitUsage } from "./capacity-units";
import { simulateEnvironment } from "./simulate";

/** ALB's published capacity unit. */
const LCU = {
  pricePerHour: 0.008,
  newConnectionsPerSec: 25,
  activeConnections: 3000,
  processedGbPerHour: 1,
};

describe("capacity units", () => {
  it("are set by new connections when every request opens one", () => {
    // 100 requests a second of 900 bytes: 4 units of connections, 2 of open ones, 0.3 of bytes.
    const usage = capacityUnitUsage(
      LCU,
      { fromClients: 100, allFromClients: 100, bytesPerSec: 90_000 },
      { requestsPerConnection: 1, connectionSec: 60, held: 0 },
    );

    expect(usage).toMatchObject({ by: "new-connections", newConnectionsPerSec: 100 });
    expect(usage.units).toBeCloseTo(4, 9);
    expect(usage.activeConnections).toBe(6000);
    expect(usage.processedGbPerHour).toBeCloseTo(0.324, 9);
    expect(usage.monthlyCost).toBeCloseTo(4 * 0.008 * HOURS_PER_MONTH, 9);
  });

  it("are set by bytes when clients reuse their connections", () => {
    const usage = capacityUnitUsage(
      LCU,
      { fromClients: 100, allFromClients: 100, bytesPerSec: 1e6 },
      { requestsPerConnection: 1000, connectionSec: 3600, held: 0 },
    );

    expect(usage.by).toBe("processed-bytes");
    expect(usage.units).toBeCloseTo(3.6, 9);
  });

  it("count the persistent connections clients hold, renewed every connectionSec", () => {
    const usage = capacityUnitUsage(
      LCU,
      { fromClients: 500, allFromClients: 500, bytesPerSec: 0 },
      { requestsPerConnection: 1, connectionSec: 3000, held: 30_000 },
    );

    expect(usage).toMatchObject({ by: "active-connections", activeConnections: 30_000 });
    expect(usage.newConnectionsPerSec).toBe(10);
    expect(usage.units).toBe(10);
  });

  it("spread held connections over the components clients connect to, by their requests", () => {
    const client = { requestsPerConnection: 1, connectionSec: 3000, held: 30_000 };
    const quarter = capacityUnitUsage(
      LCU,
      { fromClients: 100, allFromClients: 400, bytesPerSec: 0 },
      client,
    );

    expect(quarter.activeConnections).toBe(7500);
    expect(quarter.units).toBe(2.5);
  });

  it("count no client connections where clients do not connect", () => {
    const usage = capacityUnitUsage(
      LCU,
      { fromClients: 0, allFromClients: 500, bytesPerSec: 0 },
      { requestsPerConnection: 1, connectionSec: 60, held: 30_000 },
    );

    expect(usage.units).toBe(0);
  });
});

/** The test catalog with an ALB that does work: an hourly size, capacity units and a network. */
function catalogWithAlb(networkGbps?: number) {
  const copy: Catalog = JSON.parse(JSON.stringify(testCatalog));
  const alb = copy.kinds.find((k) => k.id === "load-balancer")?.flavors[0];
  if (!alb) throw new Error("no load balancer in the test catalog");
  alb.capacityUnits = LCU;
  alb.sizes = {
    managed: {
      label: "managed",
      capacityPerSec: { read: 5e6, write: 5e6 },
      latencyMs: { base: 1, cv: 0.3 },
      costPerHour: 0.0225,
      networkGbps,
      provenance: {},
    },
  };
  alb.defaultSize = "managed";
  return createCatalogIndex(CatalogSchema.parse(copy));
}

function simulate(catalog: ReturnType<typeof createCatalogIndex>, problem: Problem = testProblem) {
  const environment = EnvironmentSchema.parse({
    id: "steady",
    label: "Steady",
    rates: { redirect: 1000 },
    faults: [],
  });
  const workload = WorkloadSchema.parse({
    operations: { redirect: { entity: "Link", classes: [{ id: "all", share: 1 }] } },
    keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 1e6 } } },
    environments: [environment],
  });
  const attempt = cacheAsideAttempt();
  const analysis = analyzeAttempt(attempt, { catalog, problem });
  return simulateEnvironment(workload, environment, { attempt, catalog, problem, analysis });
}

describe("a load balancer billed in capacity units", () => {
  it("bills a unit for every 25 new connections a second, on top of its hourly charge", () => {
    const lb = simulate(catalogWithAlb()).components.get("lb");
    // The test problem's visitors open a connection per redirect.
    const units = 1000 / 25;

    expect(lb?.capacityUnits).toMatchObject({ by: "new-connections" });
    expect(lb?.capacityUnits?.units).toBeCloseTo(units, 6);
    expect(lb?.costBreakdown.capacityUnits).toBeCloseTo(units * 0.008 * HOURS_PER_MONTH, 6);
    expect(lb?.monthlyCost).toBeCloseTo((0.0225 + units * 0.008) * HOURS_PER_MONTH, 6);
  });

  it("bills fewer units when clients send many requests over a connection", () => {
    const pooled = { ...testProblem, client: { ...testProblem.client, requestsPerConnection: 10 } };
    const lb = simulate(catalogWithAlb(), pooled).components.get("lb");

    expect(lb?.capacityUnits?.newConnectionsPerSec).toBeCloseTo(100, 6);
    expect(lb?.capacityUnits?.units).toBeCloseTo(4, 6);
  });

  it("processes every request and response it forwards; the handler sends none of them", () => {
    const result = simulate(catalogWithAlb());
    // A redirect and its response are 600 and 300 bytes in the test problem.
    expect(result.components.get("lb")?.bytesOut).toBeCloseTo(1000 * 900, 3);
    expect(result.components.get("api")?.bytesOut).toBe(0);
  });

  it("fills a proxy's network with what it forwards", () => {
    // 900 KB a second over 7.2 Mbit/s is all of it.
    const lb = simulate(catalogWithAlb(0.0072)).components.get("lb");

    expect(lb?.networkUtilization).toBeCloseTo(1, 6);
    expect(lb?.utilization).toBeCloseTo(1, 6);
  });
});
