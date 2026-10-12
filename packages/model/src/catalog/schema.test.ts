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
