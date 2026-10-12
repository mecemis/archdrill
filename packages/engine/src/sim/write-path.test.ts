import { type Attempt, applyCommand, WorkloadSchema } from "@archdrill/model";
import { createLinkAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { simulateEnvironment } from "./simulate";

const STORED = 1.58e11;
const OCCUPANCY_7 = STORED / 62 ** 7;

const workload = WorkloadSchema.parse({
  operations: {
    "create-link": {
      entity: "Link",
      classes: [
        { id: "generated", share: 0.97 },
        { id: "custom-free", share: 0.02, customAlias: true },
        { id: "custom-taken", share: 0.01, customAlias: true, aliasTaken: true },
      ],
    },
  },
  keys: { Link: { existing: { distribution: "zipf", s: 1, population: 1e6 } } },
  dataset: { Link: STORED },
  keyspace: { Link: { alphabet: 62, lengthDecision: "code-length" } },
  environments: [{ id: "steady", label: "Steady", rates: { "create-link": 1000 } }],
});

function simulate(attempt: Attempt) {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  const env = workload.environments[0];
  if (!env) throw new Error("no environment");
  return simulateEnvironment(workload, env, {
    attempt,
    catalog: testCatalogIndex,
    problem: testProblem,
    analysis,
  });
}

/** Share of create requests answered with a given status. */
function statusShare(attempt: Attempt, status: number): number {
  const metrics = simulate(attempt);
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  const paths = analysis.operations.get("create-link")?.paths ?? [];
  return (metrics.operations.get("create-link")?.paths ?? []).reduce((sum, p) => {
    const path = paths.find((x) => x.id === p.pathId);
    return path?.terminal.kind === "respond" && path.terminal.status === status
      ? sum + p.probability
      : sum;
  }, 0);
}

describe("write path simulation", () => {
  it("makes random codes collide as often as the keyspace is full", () => {
    // 503s come from generated collisions only: 97% of requests × occupancy.
    expect(statusShare(createLinkAttempt("random"), 503)).toBeCloseTo(0.97 * OCCUPANCY_7, 9);
  });

  it("squares the failure rate with one retry", () => {
    expect(statusShare(createLinkAttempt("random-retry"), 503)).toBeCloseTo(
      0.97 * OCCUPANCY_7 ** 2,
      9,
    );
  });

  it("lets generated keys meet only the codes custom aliases took", () => {
    // 2% of stored links (0.02 of the 0.99 that are stored) are custom aliases.
    const aliasOccupancy = OCCUPANCY_7 * (0.02 / 0.99);

    expect(statusShare(createLinkAttempt("kgs"), 503)).toBeCloseTo(0.97 * aliasOccupancy, 12);
  });

  it("answers 409 exactly for taken aliases", () => {
    expect(statusShare(createLinkAttempt("kgs"), 409)).toBeCloseTo(0.01, 12);
  });

  it("lets the code-length decision change the collision rate", () => {
    const longer = applyCommand(createLinkAttempt("random"), "setDecision", {
      decision: "code-length",
      option: "8",
    }).attempt;
    expect(statusShare(longer, 503)).toBeCloseTo(0.97 * (STORED / 62 ** 8), 9);
  });

  it("treats an exhausted keyspace as always colliding", () => {
    const tiny = applyCommand(createLinkAttempt("random"), "setDecision", {
      decision: "code-length",
      option: "6",
    }).attempt;
    expect(statusShare(tiny, 503)).toBeCloseTo(0.97, 9);
  });

  it("calls the generator once per batch", () => {
    const unbatched = simulate(createLinkAttempt("kgs")).components.get("kgs")?.writeLoad ?? 0;
    const batched = simulate(createLinkAttempt("kgs", 1000)).components.get("kgs")?.writeLoad ?? 0;

    expect(unbatched).toBeCloseTo(970, 6);
    expect(batched).toBeCloseTo(0.97, 6);
  });
});
