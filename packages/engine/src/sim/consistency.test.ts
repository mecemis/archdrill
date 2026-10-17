import {
  type Attempt,
  applyCommand,
  type CatalogIndex,
  createCatalogIndex,
  EnvironmentSchema,
  WorkloadSchema,
} from "@archdrill/model";
import {
  cacheAsideAttempt,
  testCatalog,
  testCatalogIndex,
  testProblem,
} from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { staleReadReason } from "./consistency";
import { simulateEnvironment } from "./simulate";

const workload = WorkloadSchema.parse({
  operations: {
    redirect: {
      entity: "Link",
      classes: [
        { id: "live", share: 0.9 },
        { id: "unknown", share: 0.1, exists: false },
      ],
    },
  },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
  environments: [{ id: "env", label: "Env", rates: { redirect: 6000 } }],
});

/** The test catalog with DynamoDB metering reads in units, half a unit for an eventual read. */
const metered = createCatalogIndex({
  ...testCatalog,
  kinds: testCatalog.kinds.map((kind) => ({
    ...kind,
    flavors: kind.flavors.map((f) =>
      f.id === "dynamodb"
        ? {
            ...f,
            requestUnits: {
              per: "item" as const,
              readBytes: 4096,
              writeBytes: 1024,
              readUnits: 0.5,
            },
          }
        : f,
    ),
  })),
});

function simulate(attempt: Attempt, catalog: CatalogIndex = testCatalogIndex) {
  const analysis = analyzeAttempt(attempt, { catalog, problem: testProblem });
  return simulateEnvironment(
    workload,
    EnvironmentSchema.parse({ id: "env", label: "Env", rates: { redirect: 6000 } }),
    { attempt, catalog, problem: testProblem, analysis },
  );
}

const consistent = (attempt: Attempt) =>
  applyCommand(attempt, "updateStep", { operation: "redirect", stepId: "read", consistent: true })
    .attempt;

/** The cache-aside design with its links in DynamoDB instead of Postgres. */
function onDynamo(): Attempt {
  const base = cacheAsideAttempt();
  return {
    ...base,
    architecture: {
      ...base.architecture,
      components: base.architecture.components.map((c) =>
        c.id === "db"
          ? { ...c, kind: "key-value-db", flavor: "dynamodb", size: "on-demand", replicas: 1 }
          : c,
      ),
    },
  };
}

const component = (attempt: Attempt, id: string) => {
  const found = attempt.architecture.components.find((c) => c.id === id);
  if (!found) throw new Error(`no component ${id}`);
  return found;
};

describe("staleReadReason", () => {
  const db = component(cacheAsideAttempt(), "db");

  it("lets replicas lag unless every one applies a write before it is acknowledged", () => {
    expect(staleReadReason(db, testCatalogIndex, undefined)).toBe(
      "its replicas apply writes after the primary has acknowledged them",
    );
    expect(staleReadReason(db, testCatalogIndex, "semi-sync")).toMatch(/may not have applied/);
    expect(staleReadReason(db, testCatalogIndex, "sync")).toBeNull();
  });

  it("does not let a store without replicas lag", () => {
    const single = applyCommand(cacheAsideAttempt(), "updateComponent", {
      id: "db",
      replicas: 1,
    }).attempt;
    expect(staleReadReason(component(single, "db"), testCatalogIndex, undefined)).toBeNull();
  });

  it("calls DynamoDB's default reads eventually consistent", () => {
    expect(staleReadReason(component(onDynamo(), "db"), testCatalogIndex, undefined)).toMatch(
      /eventually consistent/,
    );
  });

  it("leaves caches out: they are not stores", () => {
    expect(
      staleReadReason(component(cacheAsideAttempt(), "redis"), testCatalogIndex, undefined),
    ).toBeNull();
  });
});

describe("a consistent read", () => {
  it("can only use the primary, so it takes a replica's worth of capacity per replica", () => {
    const eventual = simulate(cacheAsideAttempt()).components.get("db");
    const strong = simulate(consistent(cacheAsideAttempt())).components.get("db");

    // Two replicas serve ordinary reads; only the primary serves consistent ones.
    expect(strong?.readLoad).toBeCloseTo(2 * (eventual?.readLoad ?? 0), 6);
    expect(strong?.utilization).toBeGreaterThan(eventual?.utilization ?? 0);
  });

  it("costs nothing extra on a store with one copy, which every read already reaches", () => {
    const single = applyCommand(cacheAsideAttempt(), "updateComponent", {
      id: "db",
      replicas: 1,
    }).attempt;
    const eventual = simulate(single).components.get("db");
    const strong = simulate(consistent(single)).components.get("db");

    expect(strong?.readLoad).toBeCloseTo(eventual?.readLoad ?? 0, 6);
  });

  it("reads a majority of a quorum store's replicas", () => {
    // Three Cassandra replicas: a consistent read touches two of them.
    const quorum = createCatalogIndex({
      ...testCatalog,
      kinds: testCatalog.kinds.map((kind) =>
        kind.id === "relational-db" ? { ...kind, quorum: true } : kind,
      ),
    });
    const three = applyCommand(cacheAsideAttempt(), "updateComponent", {
      id: "db",
      replicas: 3,
    }).attempt;
    const eventual = simulate(three, quorum).components.get("db");
    const strong = simulate(consistent(three), quorum).components.get("db");

    expect(strong?.readLoad).toBeCloseTo(2 * (eventual?.readLoad ?? 0), 6);
  });

  it("costs DynamoDB a full read unit instead of half of one", () => {
    const eventual = simulate(onDynamo(), metered).components.get("db");
    const strong = simulate(consistent(onDynamo()), metered).components.get("db");

    expect(strong?.costBreakdown.requests).toBeCloseTo(
      2 * (eventual?.costBreakdown.requests ?? 0),
      6,
    );
  });
});
