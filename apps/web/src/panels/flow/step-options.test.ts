import type { Flow } from "@archdrill/model";
import { photosAttempt, photosCatalogIndex, photosProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import type { EditContext } from "./flow-edits";
import { patternsAt } from "./patterns";
import { callOptions, decisionOptions, responseOptions, servesOnly } from "./step-options";
import { suggestNext } from "./suggestions";

function contextFor(operationId: string): EditContext {
  const attempt = photosAttempt("direct");
  const flow = attempt.flows.find((f) => f.operation === operationId) as Flow;
  const operation = photosProblem.operations.find((o) => o.id === operationId);
  if (!operation) throw new Error(`no ${operationId}`);
  return {
    attempt,
    flow,
    operation,
    problem: photosProblem,
    catalog: photosCatalogIndex,
    background: false,
  };
}

const ROOT = { kind: "append", at: { kind: "root" } } as const;

describe("steps for object storage", () => {
  it("offers only a response, first in the flow, when object storage answers itself", () => {
    const ctx = contextFor("read-photo");

    expect(servesOnly(ctx)).toBe(true);
    expect([...callOptions(ctx.attempt, ctx.flow.handler, "Photo", ctx.catalog).keys()]).toEqual(
      [],
    );
    expect(decisionOptions(ctx, new Set())).toEqual([]);
    expect(patternsAt(ctx, ROOT, "Photo")).toEqual([]);
    expect(responseOptions(ctx, ROOT).map((o) => o.key)).toContain("respond:200");
    expect(
      suggestNext({
        ...ctx,
        slot: { operation: "read-photo", attach: { to: "root" } },
        defaultEntity: "Photo",
      }).map((s) => s.key),
    ).toEqual(["respond:200"]);
  });

  it("leaves a service's first step to calls and decisions", () => {
    const ctx = contextFor("start-upload");

    expect(servesOnly(ctx)).toBe(false);
    expect(responseOptions(ctx, ROOT)).toEqual([]);
    expect(decisionOptions(ctx, new Set()).map((o) => o.key)).toEqual(["logic:signUpload"]);
  });
});
