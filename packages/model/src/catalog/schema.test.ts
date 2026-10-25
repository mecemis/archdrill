import { describe, expect, it } from "vitest";
import { ScenarioSchema } from "../problem/schema";
import { testCatalog, testCatalogIndex } from "../testing/fixtures";
import { type Catalog, CatalogSchema } from "./schema";

describe("catalog", () => {
  it("merges kind capabilities with flavor extras", () => {
    const caps = testCatalogIndex.capabilities("cache", "redis");

    expect([...caps].sort()).toEqual(["atomic-increment", "ttl", "volatile-kv"]);
  });

  it("returns no capabilities for unknown kinds", () => {
    expect(testCatalogIndex.capabilities("quantum-db", "x").size).toBe(0);
  });

  it("rejects a default size that is not defined", () => {
    const broken: Catalog = JSON.parse(JSON.stringify(testCatalog));
    const flavor = broken.kinds.find((k) => k.id === "service")?.flavors[0];
    if (!flavor) throw new Error("fixture changed");
    flavor.defaultSize = "xl";

    expect(CatalogSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects duplicate kinds", () => {
    const broken = { ...testCatalog, kinds: [...testCatalog.kinds, testCatalog.kinds[0]] };

    expect(CatalogSchema.safeParse(broken).success).toBe(false);
  });
});

describe("data sent to the internet", () => {
  const transfer = (tiers: { fromGb: number; usdPerGb: number }[]) => ({
    ...testCatalog,
    internetTransfer: { tiers, provenance: { model: "test", basis: [] } },
  });

  it("is priced in tiers of the month's gigabytes, from the first one up", () => {
    const tiers = [
      { fromGb: 0, usdPerGb: 0.09 },
      { fromGb: 10240, usdPerGb: 0.085 },
    ];

    expect(CatalogSchema.safeParse(transfer(tiers)).success).toBe(true);
  });

  it("rejects tiers that do not start at nothing or do not climb", () => {
    expect(CatalogSchema.safeParse(transfer([{ fromGb: 10, usdPerGb: 0.09 }])).success).toBe(false);
    expect(
      CatalogSchema.safeParse(
        transfer([
          { fromGb: 0, usdPerGb: 0.09 },
          { fromGb: 0, usdPerGb: 0.05 },
        ]),
      ).success,
    ).toBe(false);
  });
});

describe("calibrations", () => {
  const benchmark = {
    id: "bench",
    title: "A benchmark",
    url: "https://example.com/bench",
    publisher: "Example",
    kind: "benchmark",
    retrieved: "2026-10-15",
  };
  const calibration = {
    id: "redis-bench",
    title: "Redis on one node",
    source: "bench",
    component: { kind: "cache", flavor: "redis", size: "m" },
    setup: "One node, 50 clients.",
    network: "zone",
    reads: 0.8,
    runs: [{ clients: 50, throughput: 100000 }],
  };
  const withCalibration = (changes: object, sources: object[] = [benchmark]) => ({
    ...testCatalog,
    sources,
    calibrations: [{ ...calibration, ...changes }],
  });

  it("accepts a benchmark replayed on a catalog size, one replica by default", () => {
    const parsed = CatalogSchema.parse(withCalibration({}));

    expect(parsed.calibrations[0]?.component.replicas).toBe(1);
  });

  it("must cite a source of kind benchmark", () => {
    expect(CatalogSchema.safeParse(withCalibration({}, [])).success).toBe(false);
    expect(
      CatalogSchema.safeParse(withCalibration({}, [{ ...benchmark, kind: "price" }])).success,
    ).toBe(false);
  });

  it("must name a size the catalog has", () => {
    const unknown = { component: { kind: "cache", flavor: "redis", size: "xl" } };

    expect(CatalogSchema.safeParse(withCalibration(unknown)).success).toBe(false);
  });

  it("explains runs the engine is known to miss, and only those", () => {
    const marked = { runs: [{ clients: 5000, throughput: 50000, beyondModel: true }] };

    expect(CatalogSchema.safeParse(withCalibration(marked)).success).toBe(false);
    expect(
      CatalogSchema.safeParse(withCalibration({ ...marked, beyondModel: "Too many connections." }))
        .success,
    ).toBe(true);
    expect(CatalogSchema.safeParse(withCalibration({ beyondModel: "Nothing." })).success).toBe(
      false,
    );
  });

  it("rejects a calibration id used twice, or a load listed twice", () => {
    const twice = {
      ...testCatalog,
      sources: [benchmark],
      calibrations: [calibration, calibration],
    };
    const repeated = {
      runs: [
        { clients: 50, throughput: 100000 },
        { clients: 50, latencyMs: 0.5 },
      ],
    };

    expect(CatalogSchema.safeParse(twice).success).toBe(false);
    expect(CatalogSchema.safeParse(withCalibration(repeated)).success).toBe(false);
  });

  it("replays only what the size can take: its replicas, its reads, its writes", () => {
    const replicated = { component: { kind: "cache", flavor: "redis", size: "m", replicas: 3 } };
    const redis = (change: (flavor: Catalog["kinds"][number]["flavors"][number]) => void) => {
      const copy: Catalog = JSON.parse(JSON.stringify(testCatalog));
      const flavor = copy.kinds.find((k) => k.id === "cache")?.flavors[0];
      if (!flavor) throw new Error("fixture changed");
      change(flavor);
      return copy;
    };
    const managed = redis((f) => {
      f.managedRedundancy = true;
    });
    const readOnly = redis((f) => {
      delete f.sizes.m?.capacityPerSec.write;
    });
    const parse = (base: Catalog, changes: object) =>
      CatalogSchema.safeParse({
        ...base,
        sources: [benchmark],
        calibrations: [{ ...calibration, ...changes }],
      }).success;

    expect(parse(testCatalog, replicated)).toBe(true);
    expect(parse(managed, replicated)).toBe(false);
    expect(parse(readOnly, { reads: 1 })).toBe(true);
    expect(parse(readOnly, { reads: 0.8 })).toBe(false);
  });

  it("needs a measurement in every run", () => {
    expect(CatalogSchema.safeParse(withCalibration({ runs: [{ clients: 50 }] })).success).toBe(
      false,
    );
  });
});

describe("scenario schema", () => {
  const base = {
    id: "s2-redirect",
    problemId: "url-shortener",
    title: "Redirect",
    order: 2,
    story: "Visitors click links.",
    focusOperations: ["redirect"],
    dimensions: { correctness: 0.6, availability: 0.4 },
    checks: [
      { id: "c1", use: "no-path", title: "t", dimension: "correctness", why: "w", fix: "f" },
    ],
  };

  it("accepts a well-formed scenario and applies defaults", () => {
    const scenario = ScenarioSchema.parse(base);

    expect(scenario.checks[0]).toMatchObject({
      weight: 1,
      gate: false,
      signal: "baseline",
      severity: "major",
    });
  });

  it("requires dimension weights to sum to 1", () => {
    const result = ScenarioSchema.safeParse({
      ...base,
      dimensions: { correctness: 0.6, availability: 0.6 },
    });

    expect(result.success).toBe(false);
  });

  it("requires baseline checks to use a weighted dimension", () => {
    const result = ScenarioSchema.safeParse({
      ...base,
      checks: [{ ...base.checks[0], dimension: "cost" }],
    });

    expect(result.success).toBe(false);
  });
});
