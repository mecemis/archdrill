import { describe, expect, it } from "vitest";
import { cacheAsideAttempt } from "../testing/fixtures";
import { describeChanges } from "./diff";
import { AttemptImportError, exportAttempt, importAttempt, migrateAttempt } from "./exchange";

describe("exportAttempt and importAttempt", () => {
  it("round-trip a design", () => {
    const attempt = cacheAsideAttempt();

    const text = exportAttempt(attempt, new Date("2026-10-13T00:00:00Z"));

    expect(JSON.parse(text)).toMatchObject({
      format: "archdrill-attempt",
      exportedAt: "2026-10-13T00:00:00.000Z",
    });
    expect(importAttempt(text)).toEqual(attempt);
  });

  it("accepts a bare attempt and fills defaults added since it was saved", () => {
    const old = JSON.parse(JSON.stringify(cacheAsideAttempt()));
    for (const connection of old.architecture.connections) delete connection.policy;

    const attempt = importAttempt(JSON.stringify(old));

    expect(attempt.architecture.connections[0]?.policy).toMatchObject({
      retries: 0,
      circuitBreaker: false,
    });
  });

  it("explains what it cannot read", () => {
    expect(() => importAttempt("not json")).toThrow("The file is not JSON.");
    expect(() => migrateAttempt([])).toThrow("This is not an ArchDrill design.");
    expect(() => migrateAttempt({ ...cacheAsideAttempt(), schemaVersion: 99 })).toThrow(
      AttemptImportError,
    );
    expect(() => migrateAttempt({ schemaVersion: 1, problemId: 3 })).toThrow(
      /^The design is not valid \(/,
    );
  });
});

describe("describeChanges", () => {
  it("summarises components, connections, policies, flows and decisions", () => {
    const before = cacheAsideAttempt();
    const after = JSON.parse(JSON.stringify(before));
    after.architecture.components.find((c: { id: string }) => c.id === "api").replicas = 10;
    after.architecture.connections.find(
      (c: { id: string }) => c.id === "api--redis",
    ).policy.timeoutMs = 20;
    delete after.flows[0].steps.populate;
    after.flows[0].steps.expiryDb.next.valid = "r302";
    after.decisions["redirect-status"] = "s302";

    expect(describeChanges(before, after)).toEqual([
      "Link API: replicas 3 → 10",
      "Link API → Redis: timeout 20 ms",
      "redirect flow: 1 removed, 1 changed",
      "Decision redirect-status: undecided → s302",
    ]);
  });
});
