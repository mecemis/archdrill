import type { RequestClass } from "@archdrill/model";
import { describe, expect, it } from "vitest";
import type { CallPathStep, LogicPathStep, PathStep } from "../paths/types";
import { callShare, type OutcomeState, outcomeProbability } from "./outcomes";

const OCCUPANCY = 0.05;
const ALIAS_OCCUPANCY = 0.001;

const state: OutcomeState = {
  callFailure: (step) => (step.target === "kgs" ? 0.1 : 0),
  hitRatio: () => 0,
  negativeHitRatio: () => 0,
  occupancy: () => OCCUPANCY,
  aliasOccupancy: () => ALIAS_OCCUPANCY,
  exists: (_entity, cls) => cls.exists,
};

const generated: RequestClass = {
  id: "generated",
  share: 1,
  exists: true,
  expired: false,
  disabled: false,
  invalidInput: false,
  customAlias: false,
  aliasTaken: false,
  hotKey: false,
  malicious: false,
  facts: [],
  counts: {},
};

const logic = (name: LogicPathStep["logic"], outcome = "ok"): LogicPathStep => ({
  kind: "logic",
  stepId: name,
  logic: name,
  outcome,
});

const call = (
  action: CallPathStep["action"],
  outcome: string,
  batchSize?: number,
): CallPathStep => ({
  kind: "call",
  stepId: action,
  target: action === "store.insertIfAbsent" ? "db" : "kgs",
  targetKind: action === "store.insertIfAbsent" ? "relational-db" : "id-generator",
  connectionId: null,
  action,
  entity: action === "store.insertIfAbsent" ? "Link" : undefined,
  ttlSec: undefined,
  batchSize,
  event: undefined,
  outcome,
});

const conflict = call("store.insertIfAbsent", "conflict");

/** Chance that a conditional insert after these steps conflicts. */
function conflictAfter(prior: readonly PathStep[], cls = generated): number {
  return outcomeProbability(conflict, cls, state, prior);
}

describe("conditional insert conflicts by key origin", () => {
  it("collides random and hashed codes at keyspace occupancy", () => {
    expect(conflictAfter([logic("generateRandomCode")])).toBe(OCCUPANCY);
    expect(conflictAfter([logic("hashUrl")])).toBe(OCCUPANCY);
  });

  it("collides allocated and leased keys only with custom aliases", () => {
    expect(conflictAfter([call("ids.allocate", "ok")])).toBe(ALIAS_OCCUPANCY);
    expect(
      conflictAfter([call("coord.leaseRange", "ok"), logic("obfuscateId"), logic("encodeBase62")]),
    ).toBe(ALIAS_OCCUPANCY);
  });

  it("collides again when the same URL is hashed again without a salt", () => {
    expect(conflictAfter([logic("hashUrl"), conflict, logic("hashUrl")])).toBe(1);
    expect(conflictAfter([logic("hashUrl"), conflict, logic("rehashWithSalt")])).toBe(OCCUPANCY);
  });

  it("judges a retry by the key it inserts, not the first attempt", () => {
    expect(conflictAfter([logic("generateRandomCode"), conflict, call("ids.allocate", "ok")])).toBe(
      ALIAS_OCCUPANCY,
    );
    expect(conflictAfter([call("ids.allocate", "ok"), conflict, logic("hashUrl")])).toBe(OCCUPANCY);
  });

  it("falls back to a generated code after a taken alias", () => {
    const taken = { ...generated, customAlias: true, aliasTaken: true };
    const prior = [logic("hasCustomAlias", "custom"), conflict, logic("generateRandomCode")];

    expect(conflictAfter([logic("hasCustomAlias", "custom")], taken)).toBe(1);
    expect(conflictAfter(prior, taken)).toBe(OCCUPANCY);
  });
});

describe("batched allocation", () => {
  it("can only be rejected on the call that refills the batch", () => {
    const batched = call("ids.allocate", "error", 1000);

    expect(outcomeProbability(batched, generated, state)).toBeCloseTo(0.1 / 1000, 15);
    expect(outcomeProbability(call("ids.allocate", "error"), generated, state)).toBe(0.1);
  });

  it("counts a failed batched call as made", () => {
    expect(callShare(call("ids.allocate", "ok", 1000))).toBe(1 / 1000);
    expect(callShare(call("ids.allocate", "error", 1000))).toBe(1);
  });
});

describe("URL-safety checks", () => {
  const healthy: OutcomeState = { ...state, callFailure: () => 0 };
  const malicious: RequestClass = { ...generated, id: "malicious", malicious: true };

  it("flag exactly the malicious requests", () => {
    const check = (outcome: string) => call("external.check", outcome);

    expect(outcomeProbability(check("malicious"), malicious, healthy)).toBe(1);
    expect(outcomeProbability(check("clean"), malicious, healthy)).toBe(0);
    expect(outcomeProbability(check("clean"), generated, healthy)).toBe(1);
    expect(outcomeProbability(check("malicious"), generated, healthy)).toBe(0);
  });
});

describe("batches that collect items", () => {
  it("fail together, unlike prefetched ids that fail only the request that fetched them", () => {
    const failing: OutcomeState = { ...state, callFailure: () => 0.1 };

    expect(outcomeProbability(call("store.delete", "error", 100), generated, failing)).toBe(0.1);
    expect(outcomeProbability(call("ids.allocate", "error", 100), generated, failing)).toBeCloseTo(
      0.001,
      12,
    );
  });

  it("make one call per batch, whatever the outcome", () => {
    expect(callShare(call("store.delete", "error", 100))).toBe(0.01);
    expect(callShare(call("ids.allocate", "error", 100))).toBe(1);
  });
});
