import { analyzeAttempt } from "@archdrill/engine";
import { type Attempt, applyCommand, type CommandArgs, type CommandName } from "@archdrill/model";
import { photosAttempt, photosCatalogIndex, photosProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { CHECKS } from "./registry";
import type { CheckOutcome } from "./types";

function run(id: string, params: unknown, attempt: Attempt): CheckOutcome {
  const check = CHECKS.get(id);
  if (!check) throw new Error(`unknown check ${id}`);
  const ctx = { catalog: photosCatalogIndex, problem: photosProblem };
  return check.run(check.params.parse(params), {
    attempt,
    ...ctx,
    analysis: analyzeAttempt(attempt, ctx),
    metrics: new Map(),
    timelines: new Map(),
  });
}

function mutate<N extends CommandName>(attempt: Attempt, name: N, args: CommandArgs<N>): Attempt {
  return applyCommand(attempt, name, args).attempt;
}

const SIGNED = { operation: "upload-photo", signedBy: "start-upload" };

describe("direct-writes-signed", () => {
  it("passes when the service signs every upload that goes straight to object storage", () => {
    expect(run("direct-writes-signed", SIGNED, photosAttempt("direct")).status).toBe("pass");
  });

  it("fails when uploads go straight to object storage and nothing signs them", () => {
    const unsigned = mutate(photosAttempt("direct"), "removeStep", {
      operation: "start-upload",
      stepId: "sign",
      bypass: "ok",
    });
    const outcome = run("direct-writes-signed", SIGNED, unsigned);

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(/anyone/);
  });

  it("fails when nothing hands out upload URLs at all", () => {
    const unsigned = mutate(photosAttempt("direct"), "removeFlow", { operation: "start-upload" });

    expect(run("direct-writes-signed", SIGNED, unsigned).status).toBe("fail");
  });

  it("does not apply when the uploads go through a service", () => {
    expect(run("direct-writes-signed", SIGNED, photosAttempt("through-service")).status).toBe(
      "n/a",
    );
  });
});

describe("entity-durable", () => {
  it("passes when a durable store keeps the entity", () => {
    const outcome = run("entity-durable", { entity: "Photo" }, photosAttempt());

    expect(outcome.status).toBe("pass");
    expect(outcome.message).toMatch(/Photos/);
  });

  it("fails when nothing keeps the entity, even though photos are served", () => {
    const unkept = mutate(photosAttempt(), "setComponentData", { id: "photos", entities: [] });
    const outcome = run("entity-durable", { entity: "Photo" }, unkept);

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(/Nothing keeps Photo/);
  });
});
