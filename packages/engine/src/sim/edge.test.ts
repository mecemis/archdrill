import {
  type CatalogIndex,
  CatalogSchema,
  createCatalogIndex,
  EnvironmentSchema,
  WorkloadSchema,
} from "@archdrill/model";
import {
  type PhotoRoute,
  photosAttempt,
  photosCatalogIndex,
  photosProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { cacheHitRatio } from "./cache-model";
import { SECONDS_PER_MONTH } from "./capacity";
import { tieredCost } from "./internet";
import { simulateEnvironment } from "./simulate";

const POPULARITY = { s: 0.9, population: 1e8 };
const DAY = 86_400;

function simulate(
  route: PhotoRoute,
  { reads = 4000, viral = 0, catalog = photosCatalogIndex as CatalogIndex } = {},
) {
  const attempt = photosAttempt(route);
  const rates = { "start-upload": 100, "upload-photo": 100, "read-photo": reads };
  const environment = EnvironmentSchema.parse({ id: "steady", label: "Steady", rates, faults: [] });
  const author = { entity: "Photo", classes: [{ id: "author", share: 1 }] };
  const readers = [
    { id: "reader", share: 1 - viral },
    ...(viral > 0 ? [{ id: "viral", share: viral, hotKey: true }] : []),
  ];
  const workload = WorkloadSchema.parse({
    operations: {
      "start-upload": author,
      "upload-photo": author,
      "read-photo": { entity: "Photo", classes: readers },
    },
    keys: { Photo: { existing: { distribution: "zipf", ...POPULARITY } } },
    dataset: { Photo: POPULARITY.population },
    environments: [environment],
  });
  const ctx = { catalog, problem: photosProblem };
  return simulateEnvironment(workload, environment, {
    attempt,
    ...ctx,
    analysis: analyzeAttempt(attempt, ctx),
  });
}

const edgeHit = (reads: number) =>
  cacheHitRatio({
    rate: reads,
    popularity: POPULARITY,
    capacityItems: Number.POSITIVE_INFINITY,
    ttlSec: DAY,
  });

describe("a CDN in front of object storage", () => {
  it("answers what it keeps at the edge, and sends only the misses to the origin", () => {
    const result = simulate("cdn");
    const hit = edgeHit(4000);
    const cache = result.caches.find((c) => c.componentId === "edge");

    expect(hit).toBeGreaterThan(0.3);
    expect(cache?.hitRatio).toBeCloseTo(hit, 3);
    expect(result.components.get("edge")?.readLoad).toBeCloseTo(4000, 6);
    expect(result.components.get("photos")?.readLoad).toBeCloseTo(4000 * (1 - hit), 0);
  });

  it("leaves uploads, which the edge cannot keep, to go around it", () => {
    const result = simulate("cdn");

    expect(result.components.get("edge")?.writeLoad).toBe(0);
    expect(result.components.get("photos")?.writeLoad).toBeCloseTo(100, 6);
  });

  it("bills every request it answers, hits and misses", () => {
    const edge = simulate("cdn").components.get("edge");

    expect(edge?.costBreakdown.requests).toBeCloseTo((4000 * 1 * SECONDS_PER_MONTH) / 1e6, 2);
  });

  it("answers most photos in the edge's own time, and the misses in the origin's", () => {
    const viaEdge = simulate("cdn").operations.get("read-photo");
    const direct = simulate("direct").operations.get("read-photo");

    expect(viaEdge?.successRate).toBeCloseTo(1, 6);
    expect(viaEdge?.latency.p50).toBeLessThan(20);
    expect(direct?.latency.p50).toBeGreaterThan(100);
    // The misses still wait for the origin.
    expect(viaEdge?.latency.p99).toBeGreaterThan(100);
  });

  it("keeps a viral photo at the edge, sparing the one prefix it lives in", () => {
    const direct = simulate("direct", { reads: 30_000, viral: 0.5 });
    const viaEdge = simulate("cdn", { reads: 30_000, viral: 0.5 });
    const prefix = direct.components.get("photos");

    // 15,000 reads a second of one photo, on a prefix that takes 5,500.
    expect(prefix?.hottestShardUtilization).toBeGreaterThan(2);
    expect(direct.operations.get("read-photo")?.successRate).toBeLessThan(0.8);
    expect(viaEdge.operations.get("read-photo")?.successRate).toBeCloseTo(1, 3);
    expect(viaEdge.components.get("photos")?.hottestShardUtilization).toBeLessThan(1);
  });

  it("bills what it sends clients at its own tiers, apart from the Region's", () => {
    const regionTiers = [{ fromGb: 0, usdPerGb: 0.09 }];
    const edgeTiers = [
      { fromGb: 0, usdPerGb: 0.085 },
      { fromGb: 10240, usdPerGb: 0.08 },
    ];
    const source = photosCatalogIndex.catalog;
    const catalog = createCatalogIndex(
      CatalogSchema.parse({
        ...source,
        internetTransfer: { tiers: regionTiers, provenance: { model: "test", basis: [] } },
        kinds: source.kinds.map((kind) =>
          kind.id === "cdn"
            ? {
                ...kind,
                flavors: kind.flavors.map((f) => ({
                  ...f,
                  internetTransfer: { tiers: edgeTiers, provenance: { model: "test", basis: [] } },
                })),
              }
            : kind,
        ),
      }),
    );
    const result = simulate("cdn", { catalog });
    const edge = result.components.get("edge");
    const gb = ((edge?.bytesToClients ?? 0) * SECONDS_PER_MONTH) / 1e9;

    expect(edge?.costBreakdown.internet).toBeCloseTo(tieredCost(gb, edgeTiers), 2);
  });
});
