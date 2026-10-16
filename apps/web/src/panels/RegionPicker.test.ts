import { applyCommand, type Component, createCatalogIndex } from "@archdrill/model";
import { cacheAsideAttempt, testCatalog, testCatalogIndex } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { regionHint } from "./RegionPicker";

function component(id: string, changes: Record<string, unknown> = {}): Component {
  const attempt = applyCommand(cacheAsideAttempt(), "updateComponent", { id, ...changes }).attempt;
  const found = attempt.architecture.components.find((c) => c.id === id);
  if (!found) throw new Error(`no component ${id}`);
  return found;
}

/** The test catalog with Postgres promoted in three minutes and Redis kept filled across regions. */
const catalog = createCatalogIndex({
  ...testCatalog,
  kinds: testCatalog.kinds.map((kind) => ({
    ...kind,
    flavors: kind.flavors.map((f) =>
      f.id === "postgres"
        ? { ...f, regionFailoverSec: 180 }
        : f.id === "redis"
          ? { ...f, crossRegionReplication: true }
          : f,
    ),
  })),
});

describe("regionHint", () => {
  it("warns that a component in one region goes with it", () => {
    expect(regionHint(component("api"), testCatalogIndex)).toBe(
      "Runs only in the primary region, so losing that region takes this down.",
    );
  });

  it("says when a standby store takes writes", () => {
    expect(regionHint(component("db", { regions: 2 }), catalog)).toBe(
      "A standby copy in a second region, replicated asynchronously. It takes writes once promoted, 3 minutes after the region is declared lost.",
    );
  });

  it("tells a standby cache kept filled from one that starts empty", () => {
    expect(regionHint(component("redis", { regions: 2 }), catalog)).toBe(
      "A standby copy in a second region, kept filled from the primary one.",
    );
    expect(regionHint(component("redis", { regions: 2 }), testCatalogIndex)).toBe(
      "A standby copy in a second region. Nothing fills it, so it takes traffic empty.",
    );
  });

  it("says what a standby fleet runs while it waits", () => {
    expect(regionHint(component("api", { regions: 2 }), testCatalogIndex)).toBe(
      "A standby copy runs the same 3 instances, idle until traffic arrives.",
    );
  });
});
