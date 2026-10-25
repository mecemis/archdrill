import {
  type Catalog,
  CatalogSchema,
  createCatalogIndex,
  EnvironmentSchema,
  WorkloadSchema,
} from "@archdrill/model";
import {
  cacheAsideAttempt,
  photosAttempt,
  photosCatalogIndex,
  photosProblem,
  testCatalog,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { SECONDS_PER_MONTH } from "./capacity";
import { tieredCost } from "./internet";
import { simulateEnvironment } from "./simulate";

/** AWS's tiers for data out of us-east-1 to the internet. */
const TIERS = [
  { fromGb: 0, usdPerGb: 0.09 },
  { fromGb: 10240, usdPerGb: 0.085 },
  { fromGb: 51200, usdPerGb: 0.07 },
  { fromGb: 153600, usdPerGb: 0.05 },
];

/** The catalog with the Region's transfer tiers, and a managed load balancer it can measure. */
const withTransfer = (catalog: Catalog, priced = true) =>
  createCatalogIndex(
    CatalogSchema.parse({
      ...catalog,
      kinds: catalog.kinds.map((kind) =>
        kind.id === "load-balancer"
          ? {
              ...kind,
              flavors: kind.flavors.map((f) => ({
                ...f,
                sizes: {
                  managed: {
                    label: "managed",
                    capacityPerSec: { read: 1e6, write: 1e6 },
                    latencyMs: { base: 1, cv: 0.3 },
                    costPerHour: 0.0225,
                  },
                },
                defaultSize: "managed",
              })),
            }
          : kind,
      ),
      ...(priced && {
        internetTransfer: { tiers: TIERS, provenance: { model: "test", basis: [] } },
      }),
    }),
  );

const monthlyGb = (bytesPerSec: number) => (bytesPerSec * SECONDS_PER_MONTH) / 1e9;

describe("tiered prices", () => {
  it("bill each GB of the month at the tier it falls in", () => {
    expect(tieredCost(0, TIERS)).toBe(0);
    expect(tieredCost(1000, TIERS)).toBeCloseTo(90, 9);
    expect(tieredCost(20000, TIERS)).toBeCloseTo(10240 * 0.09 + 9760 * 0.085, 9);
    expect(tieredCost(200000, TIERS)).toBeCloseTo(
      10240 * 0.09 + 40960 * 0.085 + 102400 * 0.07 + 46400 * 0.05,
      6,
    );
  });
});

describe("data sent to clients over the internet", () => {
  it("is billed to the component the clients talk to, for every response it sends them", () => {
    const attempt = cacheAsideAttempt();
    const catalog = withTransfer(testCatalog);
    const environment = EnvironmentSchema.parse({
      id: "steady",
      label: "Steady",
      rates: { redirect: 1000 },
      faults: [],
    });
    const workload = WorkloadSchema.parse({
      operations: { redirect: { entity: "Link", classes: [{ id: "all", share: 1 }] } },
      keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 1e8 } } },
      environments: [environment],
    });
    const result = simulateEnvironment(workload, environment, {
      attempt,
      catalog,
      problem: testProblem,
      analysis: analyzeAttempt(attempt, { catalog, problem: testProblem }),
    });
    const response = testProblem.operations.find((o) => o.id === "redirect")?.bytes?.response ?? 0;
    const lb = result.components.get("lb");

    expect(lb?.bytesToClients).toBeCloseTo(1000 * response, 6);
    expect(lb?.costBreakdown.internet).toBeCloseTo(
      tieredCost(monthlyGb(1000 * response), TIERS),
      6,
    );
    expect(result.components.get("api")?.costBreakdown.internet).toBe(0);
    expect(result.components.get("api")?.bytesToClients).toBe(0);
  });

  it("shares the month's tiers among everything that sends to clients", () => {
    const attempt = photosAttempt("direct");
    const catalog = withTransfer(photosCatalogIndex.catalog);
    const rates = { "start-upload": 100, "upload-photo": 100, "read-photo": 400 };
    const environment = EnvironmentSchema.parse({
      id: "steady",
      label: "Steady",
      rates,
      faults: [],
    });
    const photo = { entity: "Photo", classes: [{ id: "all", share: 1 }] };
    const workload = WorkloadSchema.parse({
      operations: { "start-upload": photo, "upload-photo": photo, "read-photo": photo },
      environments: [environment],
    });
    const result = simulateEnvironment(workload, environment, {
      attempt,
      catalog,
      problem: photosProblem,
      analysis: analyzeAttempt(attempt, { catalog, problem: photosProblem }),
    });
    const lb = result.components.get("lb");
    const photos = result.components.get("photos");
    const sent = (lb?.bytesToClients ?? 0) + (photos?.bytesToClients ?? 0);

    // Photos are sent by S3 itself, upload URLs by the load balancer.
    expect(photos?.bytesToClients).toBeGreaterThan(lb?.bytesToClients ?? 0);
    expect((lb?.costBreakdown.internet ?? 0) + (photos?.costBreakdown.internet ?? 0)).toBeCloseTo(
      tieredCost(monthlyGb(sent), TIERS),
      6,
    );
    expect((photos?.costBreakdown.internet ?? 0) / (lb?.costBreakdown.internet ?? 1)).toBeCloseTo(
      (photos?.bytesToClients ?? 0) / (lb?.bytesToClients ?? 1),
      6,
    );
  });

  it("is free where the catalog prices no transfer", () => {
    const attempt = cacheAsideAttempt();
    const catalog = withTransfer(testCatalog, false);
    const environment = EnvironmentSchema.parse({
      id: "steady",
      label: "Steady",
      rates: { redirect: 1000 },
      faults: [],
    });
    const workload = WorkloadSchema.parse({
      operations: { redirect: { entity: "Link", classes: [{ id: "all", share: 1 }] } },
      environments: [environment],
    });
    const result = simulateEnvironment(workload, environment, {
      attempt,
      catalog,
      problem: testProblem,
      analysis: analyzeAttempt(attempt, { catalog, problem: testProblem }),
    });

    expect(result.components.get("lb")?.costBreakdown.internet).toBe(0);
  });
});
