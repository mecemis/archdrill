import { applyCommand } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "./analyze";
import { describePath } from "./paths/describe";

const ctx = { catalog: testCatalogIndex, problem: testProblem };

describe("analyzeAttempt", () => {
  it("enumerates every path of the redirect flow in a deterministic order", () => {
    const redirect = analyzeAttempt(cacheAsideAttempt(), ctx).operations.get("redirect");

    expect(redirect?.status).toBe("ready");
    expect(redirect?.paths.map(describePath)).toEqual([
      "hit → valid → 302",
      "hit → expired → 410",
      "miss → found → valid → ok → 302",
      "miss → found → valid → error → 302",
      "miss → found → expired → 410",
      "miss → notFound → 404",
      "miss → error → 503",
      "error → found → valid → ok → 302",
      "error → found → valid → error → 302",
      "error → found → expired → 410",
      "error → notFound → 404",
      "error → error → 503",
    ]);
  });

  it("records the components and connections each path touches", () => {
    const path = analyzeAttempt(cacheAsideAttempt(), ctx).operations.get("redirect")?.paths[2];

    expect(path?.components).toEqual(["client", "lb", "api", "redis", "db"]);
    expect(path?.connections).toEqual(["client--lb", "lb--api", "api--redis", "api--db"]);
  });

  it("ends a path at an unhandled outcome instead of guessing", () => {
    const attempt = applyCommand(cacheAsideAttempt(), "linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "notFound",
      target: null,
    }).attempt;

    const paths = analyzeAttempt(attempt, ctx).operations.get("redirect")?.paths ?? [];

    expect(paths.map(describePath)).toContain("miss → notFound → unhandled");
  });

  it("enumerates negative hits once negative caching is part of the design", () => {
    let attempt = applyCommand(cacheAsideAttempt(), "addStep", {
      operation: "redirect",
      id: "neg",
      step: {
        type: "call",
        target: "redis",
        action: "cache.setNegative",
        entity: "Link",
        ttlSec: 60,
      },
      attach: { to: "outcome", stepId: "read", outcome: "notFound" },
      continueWith: { outcome: "ok" },
    }).attempt;
    attempt = applyCommand(attempt, "linkOutcome", {
      operation: "redirect",
      stepId: "get",
      outcome: "negativeHit",
      target: "r404",
    }).attempt;

    const labels = analyzeAttempt(attempt, ctx).operations.get("redirect")?.paths.map(describePath);

    expect(labels?.slice(0, 3)).toEqual([
      "hit → valid → 302",
      "hit → expired → 410",
      "negativeHit → 404",
    ]);
  });

  it("reports operations without flows as missing", () => {
    const analysis = analyzeAttempt(cacheAsideAttempt(), ctx);

    expect(analysis.operations.get("create-link")?.status).toBe("missing");
  });

  it("does not walk flows with structural errors", () => {
    const attempt = applyCommand(cacheAsideAttempt(), "linkOutcome", {
      operation: "redirect",
      stepId: "populate",
      outcome: "error",
      target: "get",
    }).attempt;

    const analysis = analyzeAttempt(attempt, ctx);

    expect(analysis.evaluable).toBe(false);
    expect(analysis.operations.get("redirect")?.status).toBe("broken");
  });

  it("lists components that no path touches", () => {
    const attempt = applyCommand(cacheAsideAttempt(), "addComponent", {
      id: "kafka",
      kind: "cache",
      flavor: "redis",
      label: "Unused cache",
      position: { x: 0, y: 0 },
    }).attempt;

    const analysis = analyzeAttempt(attempt, ctx);

    expect(analysis.unusedComponents).toEqual(["kafka"]);
    expect([...(analysis.usage.get("db") ?? [])]).toEqual(["redirect"]);
  });

  it("keeps analysing when a call has no connection, so the paths can still be shown", () => {
    const attempt = applyCommand(cacheAsideAttempt(), "removeConnection", {
      id: "api--redis",
    }).attempt;

    const analysis = analyzeAttempt(attempt, ctx);
    const first = analysis.operations.get("redirect")?.paths[0]?.steps[0];

    expect(analysis.evaluable).toBe(false);
    expect(first).toMatchObject({ kind: "call", target: "redis", connectionId: null });
  });
});
