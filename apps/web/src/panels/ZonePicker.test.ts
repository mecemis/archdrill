import { applyCommand, type Component } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { zoneHint } from "./ZonePicker";

function component(id: string, changes: Record<string, number>): Component {
  const attempt = applyCommand(cacheAsideAttempt(), "updateComponent", { id, ...changes }).attempt;
  const found = attempt.architecture.components.find((c) => c.id === id);
  if (!found) throw new Error(`no component ${id}`);
  return found;
}

describe("zoneHint", () => {
  it("warns that one zone is one point of failure", () => {
    expect(zoneHint(component("api", {}), testCatalogIndex)).toBe(
      "Every instance is in one zone, so losing that zone takes this down.",
    );
  });

  it("says how much of a spread fleet a lost zone takes", () => {
    expect(zoneHint(component("api", { zones: 3 }), testCatalogIndex)).toBe(
      "Losing a zone takes 33% of its instances; the others carry on.",
    );
  });

  it("says when shards with one instance each lose their keys", () => {
    expect(
      zoneHint(component("redis", { replicas: 1, shards: 4, zones: 2 }), testCatalogIndex),
    ).toBe("Each shard has one instance, so losing a zone loses the keys on its shards.");
  });
});
