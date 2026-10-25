import { EnvironmentSchema, WorkloadSchema } from "@archdrill/model";
import {
  cacheAsideAttempt,
  type PhotoRoute,
  photosAttempt,
  photosCatalogIndex,
  photosProblem,
  testCatalogIndex,
  testProblem,
  withNearCache,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import type { CallPathStep } from "../paths/types";
import { BYTES_PER_GBIT, SECONDS_PER_MONTH } from "./capacity";
import { simulateEnvironment } from "./simulate";
import { stepCosts } from "./step-costs";

const RATES = { "start-upload": 100, "upload-photo": 100, "read-photo": 400 };
const PHOTO_BYTES = 200_000;
const PHOTOS_STORED = 1e9;

function simulate(route: PhotoRoute) {
  const attempt = photosAttempt(route);
  const environment = EnvironmentSchema.parse({
    id: "steady",
    label: "Steady",
    rates: RATES,
    faults: [],
  });
  const photo = { entity: "Photo", classes: [{ id: "all", share: 1 }] };
  const workload = WorkloadSchema.parse({
    operations: { "start-upload": photo, "upload-photo": photo, "read-photo": photo },
    keys: { Photo: { existing: { distribution: "zipf", s: 0.9, population: PHOTOS_STORED } } },
    dataset: { Photo: PHOTOS_STORED },
    environments: [environment],
  });
  const ctx = { catalog: photosCatalogIndex, problem: photosProblem };
  return simulateEnvironment(workload, environment, {
    attempt,
    ...ctx,
    analysis: analyzeAttempt(attempt, ctx),
  });
}

const operationBytes = (id: string) => {
  const bytes = photosProblem.operations.find((o) => o.id === id)?.bytes;
  if (!bytes) throw new Error(`no sizes for ${id}`);
  return bytes;
};

describe("object storage that answers clients itself", () => {
  it("takes reads and writes per prefix, as S3 does", () => {
    const photos = simulate("direct").components.get("photos");

    expect(photos?.readLoad).toBeCloseTo(RATES["read-photo"], 6);
    expect(photos?.writeLoad).toBeCloseTo(RATES["upload-photo"], 6);
    expect(photos?.utilization).toBeCloseTo(
      RATES["read-photo"] / (5500 * 4) + RATES["upload-photo"] / (3500 * 4),
      6,
    );
  });

  it("bills every request it answers, and the photos it keeps", () => {
    const photos = simulate("direct").components.get("photos");
    const requests =
      ((RATES["read-photo"] * 0.4 + RATES["upload-photo"] * 5) * SECONDS_PER_MONTH) / 1e6;

    expect(photos?.costBreakdown.requests).toBeCloseTo(requests, 2);
    expect(photos?.costBreakdown.storage).toBeCloseTo(
      ((PHOTOS_STORED * PHOTO_BYTES) / 1e9) * 0.023,
      2,
    );
    expect(photos?.costBreakdown.instances).toBe(0);
  });

  it("answers in its own time: about 120 ms a request", () => {
    const read = simulate("direct").operations.get("read-photo");

    expect(read?.successRate).toBeCloseTo(1, 6);
    expect(read?.latency.p50).toBeGreaterThan(100);
    expect(read?.latency.p99).toBeLessThan(300);
  });
});

describe("what a service sends", () => {
  it("counts its responses and the items its calls send against its network", () => {
    const api = simulate("through-service").components.get("api");
    const sent =
      RATES["start-upload"] * operationBytes("start-upload").response +
      RATES["upload-photo"] * (operationBytes("upload-photo").response + PHOTO_BYTES) +
      RATES["read-photo"] * operationBytes("read-photo").response;

    expect(api?.bytesOut).toBeCloseTo(sent, 0);
    expect(api?.networkUtilization).toBeCloseTo(sent / (2 * 1.562 * BYTES_PER_GBIT), 6);
  });

  it("sends almost nothing when clients move the photos themselves", () => {
    const api = simulate("direct").components.get("api");

    expect(api?.bytesOut).toBeCloseTo(
      RATES["start-upload"] * operationBytes("start-upload").response,
      0,
    );
  });

  it("never sends what it writes to a cache in its own memory", () => {
    const attempt = withNearCache(cacheAsideAttempt());
    const catalog = testCatalogIndex;
    const analysis = analyzeAttempt(attempt, { catalog, problem: testProblem });
    const paths = analysis.operations.get("redirect")?.paths ?? [];
    const ctx = { attempt, catalog, problem: testProblem, analysis };
    const sent = new Map<string, number>();
    stepCosts(paths, ctx).forEach((costs, p) => {
      costs.forEach((cost, s) => {
        const step = paths[p]?.steps[s];
        if (step?.kind === "call") sent.set((step as CallPathStep).stepId, cost.sentBytes);
      });
    });
    const link = testProblem.entities.find((e) => e.name === "Link")?.avgBytes;

    expect(sent.get("near-set")).toBe(0);
    expect(sent.get("populate")).toBe(link);
    expect(sent.get("get")).toBe(0);
  });
});
