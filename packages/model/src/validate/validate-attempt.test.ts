import { describe, expect, it } from "vitest";
import { type Attempt, AttemptSchema, DEFAULT_POLICY } from "../attempt/schema";
import { applyCommand, type CommandArgs, type CommandName } from "../commands/index";
import { asyncAttempt } from "../testing/async";
import {
  cacheAsideAttempt,
  pooledCatalogIndex,
  testCatalogIndex,
  testProblem,
} from "../testing/fixtures";
import { createLinkAttempt } from "../testing/write-path";
import type { IssueCode } from "./issues";
import { validateAttempt } from "./validate-attempt";

const ctx = { catalog: testCatalogIndex, problem: testProblem };

function codes(attempt: Attempt): IssueCode[] {
  return validateAttempt(attempt, ctx).map((issue) => issue.code);
}

function mutate<N extends CommandName>(
  name: N,
  args: CommandArgs<N>,
  base = cacheAsideAttempt(),
): Attempt {
  return applyCommand(base, name, args).attempt;
}

describe("validateAttempt", () => {
  it("accepts the complete cache-aside fixture without issues", () => {
    expect(validateAttempt(cacheAsideAttempt(), ctx)).toEqual([]);
  });

  it("reports an unreachable handler when the ingress connection is reversed", () => {
    const attempt = mutate("reverseConnection", { id: "lb--api" });

    expect(codes(attempt)).toContain("flow-handler-unreachable");
  });

  it("reports a call without a connection when the dependency edge is reversed", () => {
    const attempt = mutate("reverseConnection", { id: "api--redis" });

    const issues = validateAttempt(attempt, ctx).filter((i) => i.code === "step-no-connection");
    expect(issues.map((i) => i.location)).toEqual([
      { type: "step", operation: "redirect", stepId: "get" },
      { type: "step", operation: "redirect", stepId: "populate" },
    ]);
  });

  it("warns about unhandled outcomes with the exact step and outcome", () => {
    const attempt = mutate("linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "notFound",
      target: null,
    });

    const issue = validateAttempt(attempt, ctx).find((i) => i.code === "step-unhandled-outcome");
    expect(issue?.severity).toBe("warning");
    expect(issue?.location).toEqual({
      type: "step",
      operation: "redirect",
      stepId: "read",
      outcome: "notFound",
    });
  });

  it("asks for a negative-hit branch only once the design stores negative entries", () => {
    const withNegative = mutate("addStep", {
      operation: "redirect",
      step: {
        type: "call",
        target: "redis",
        action: "cache.setNegative",
        entity: "Link",
        ttlSec: 60,
      },
      attach: { to: "outcome", stepId: "read", outcome: "notFound" },
      continueWith: { outcome: "ok" },
    });

    const unhandled = (attempt: Attempt) =>
      validateAttempt(attempt, ctx)
        .filter((i) => i.code === "step-unhandled-outcome")
        .map((i) => i.location);

    expect(unhandled(cacheAsideAttempt())).toEqual([]);
    expect(unhandled(withNegative)).toContainEqual({
      type: "step",
      operation: "redirect",
      stepId: "get",
      outcome: "negativeHit",
    });
  });

  it("does not let an unreachable negative-cache step enable negative hits", () => {
    const orphan = mutate("addStep", {
      operation: "redirect",
      step: {
        type: "call",
        target: "redis",
        action: "cache.setNegative",
        entity: "Link",
        ttlSec: 60,
      },
      attach: { to: "outcome", stepId: "read", outcome: "notFound" },
      continueWith: { outcome: "ok" },
    });
    const detached = mutate(
      "linkOutcome",
      { operation: "redirect", stepId: "read", outcome: "notFound", target: "r404" },
      orphan,
    );

    const codes = validateAttempt(detached, ctx).map(
      (i) => `${i.code}:${"outcome" in i.location ? i.location.outcome : ""}`,
    );

    expect(codes).toContain("step-unreachable:");
    expect(codes).not.toContain("step-unhandled-outcome:negativeHit");
  });

  it("does not let negative caching behind the negative-hit branch justify itself", () => {
    const linked = mutate("linkOutcome", {
      operation: "redirect",
      stepId: "get",
      outcome: "negativeHit",
      target: "r404",
    });
    const selfJustifying = mutate(
      "addStep",
      {
        operation: "redirect",
        id: "neg",
        step: {
          type: "call",
          target: "redis",
          action: "cache.setNegative",
          entity: "Link",
          ttlSec: 60,
        },
        attach: { to: "root" },
        continueWith: { outcome: "ok" },
      },
      mutate(
        "linkOutcome",
        { operation: "redirect", stepId: "get", outcome: "negativeHit", target: null },
        linked,
      ),
    );
    // Now: neg (root) → get; but move neg behind get's negativeHit so it can only run after a negative hit.
    const hidden = mutate(
      "setRoot",
      { operation: "redirect", stepId: "get" },
      mutate(
        "linkOutcome",
        { operation: "redirect", stepId: "get", outcome: "negativeHit", target: "neg" },
        selfJustifying,
      ),
    );

    const issues = validateAttempt(hidden, ctx).map(
      (i) => `${i.code}:${"stepId" in i.location ? i.location.stepId : ""}`,
    );

    expect(issues).toContain("step-infeasible-outcome:get");
    expect(issues).toContain("step-unreachable:neg");
  });

  it("rejects durable-store actions on a store that does not hold the entity", () => {
    const attempt = mutate("setComponentData", { id: "db", entities: [] });

    expect(codes(attempt)).toContain("step-entity-not-stored");
  });

  it("rejects actions the target cannot perform", () => {
    const base = cacheAsideAttempt();
    const flow = base.flows[0];
    const step = flow?.steps.read;
    if (!flow || step?.type !== "call") throw new Error("fixture changed");
    const attempt: Attempt = {
      ...base,
      flows: [{ ...flow, steps: { ...flow.steps, read: { ...step, target: "redis" } } }],
    };

    expect(codes(attempt)).toContain("step-action-not-supported");
  });

  it("requires ttlSec on cache.set", () => {
    const attempt = mutate("updateStep", {
      operation: "redirect",
      stepId: "populate",
      ttlSec: null,
    });

    expect(codes(attempt)).toContain("step-missing-param");
  });

  it("detects loops between steps", () => {
    const attempt = mutate("linkOutcome", {
      operation: "redirect",
      stepId: "populate",
      outcome: "error",
      target: "get",
    });

    expect(codes(attempt)).toContain("flow-cycle");
  });

  it("flags steps that are not reachable from the first step", () => {
    const attempt = mutate("linkOutcome", {
      operation: "redirect",
      stepId: "read",
      outcome: "error",
      target: null,
    });
    const orphanAttempt = mutate(
      "linkOutcome",
      { operation: "redirect", stepId: "read", outcome: "notFound", target: "r503" },
      attempt,
    );

    expect(codes(orphanAttempt)).toContain("step-unreachable");
  });

  it("rejects a handler that is not a service", () => {
    const attempt = mutate("setFlowHandler", { operation: "redirect", handler: "db" });

    expect(codes(attempt)).toContain("flow-handler-not-compute");
  });

  it("rejects duplicate connections and self-loops", () => {
    const base = cacheAsideAttempt();
    const attempt: Attempt = {
      ...base,
      architecture: {
        ...base.architecture,
        connections: [
          ...base.architecture.connections,
          { id: "dup", from: "lb", to: "api", policy: DEFAULT_POLICY },
          { id: "loop", from: "api", to: "api", policy: DEFAULT_POLICY },
        ],
      },
    };

    expect(codes(attempt)).toEqual(
      expect.arrayContaining(["connection-duplicate", "connection-self-loop"]),
    );
  });

  it("rejects unknown flavors, sizes and replicas on non-replicable kinds", () => {
    const attempt = mutate("updateComponent", { id: "lb", replicas: 2 });
    const unknownSize = mutate("updateComponent", { id: "api", size: "xxl" });

    expect(codes(attempt)).toContain("replicas-not-supported");
    expect(codes(unknownSize)).toContain("unknown-size");
  });

  it("warns that replicas are ignored on managed components", () => {
    const base = cacheAsideAttempt();
    const components = base.architecture.components.map((c) =>
      c.id === "lb" ? { ...c, replicas: 3 } : c,
    );
    const managed: Attempt = { ...base, architecture: { ...base.architecture, components } };

    const issue = validateAttempt(managed, ctx).find((i) => i.code === "replicas-ignored");

    expect(issue?.severity).toBe("warning");
  });

  it("spreads instances over no more zones than there are instances", () => {
    const base = cacheAsideAttempt();
    const components = base.architecture.components.map((c) =>
      c.id === "redis" ? { ...c, zones: 3 } : c.id === "lb" ? { ...c, zones: 2 } : c,
    );
    const placed: Attempt = { ...base, architecture: { ...base.architecture, components } };

    const issues = validateAttempt(placed, ctx);

    expect(issues.find((i) => i.code === "zones-exceed-instances")?.message).toBe(
      "Redis runs 2 instances, too few to spread over 3 zones.",
    );
    expect(issues.find((i) => i.code === "zones-ignored")).toMatchObject({
      severity: "warning",
      message: "ALB spans zones on its own; its zone count is ignored.",
    });
  });

  it("loads designs saved with asynchronous connections, and calls over them", () => {
    const saved = JSON.parse(JSON.stringify(asyncAttempt()));
    for (const connection of saved.architecture.connections) {
      if (connection.to === "queue") connection.mode = "async";
    }
    const loaded = AttemptSchema.parse(saved);

    expect(loaded.architecture.connections.some((c) => "mode" in c)).toBe(false);
    expect(validateAttempt(loaded, ctx).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("puts a connection proxy only in front of a store that has one", () => {
    const pooled = { ...ctx, catalog: pooledCatalogIndex };
    const proxied = mutate("updateComponent", { id: "db", proxy: true });
    const cache = mutate("updateComponent", { id: "redis", proxy: true });

    expect(validateAttempt(proxied, pooled)).toEqual([]);
    expect(validateAttempt(cache, pooled).find((i) => i.code === "proxy-ignored")).toMatchObject({
      severity: "warning",
      message: "Redis has no connection proxy to put in front of it; it is ignored.",
    });
  });

  it("sizes pools only for stores that run one statement per connection", () => {
    const pooled = { ...ctx, catalog: pooledCatalogIndex };
    const toDb = mutate("setConnectionPolicy", { id: "api--db", poolSize: 20 });
    const toCache = mutate("setConnectionPolicy", { id: "api--redis", poolSize: 20 });

    expect(validateAttempt(toDb, pooled)).toEqual([]);
    expect(validateAttempt(toCache, pooled).find((i) => i.code === "pool-ignored")).toMatchObject({
      severity: "warning",
      message: "Redis serves many calls over each connection; the pool size is ignored.",
      location: { type: "connection", connectionId: "api--redis" },
    });
  });

  it("accepts an outbox publish only after a transactional write", () => {
    const behind = applyCommand(asyncAttempt(), "updateStep", {
      operation: "create-link",
      stepId: "publish",
      outbox: true,
    }).attempt;
    const alone = applyCommand(behind, "addStep", {
      operation: "purge-expired",
      id: "announce",
      step: {
        type: "call",
        target: "queue",
        action: "queue.publish",
        event: "link-created",
        outbox: true,
      },
      attach: { to: "root" },
      continueWith: { outcome: "ok" },
    }).attempt;

    expect(codes(behind)).not.toContain("step-outbox-without-transaction");
    expect(codes(alone)).toContain("step-outbox-without-transaction");
  });

  it("sends only store writes to the home region", () => {
    const cache = mutate("updateStep", { operation: "redirect", stepId: "get", homeRegion: true });

    expect(codes(cache)).toContain("step-unexpected-param");
  });

  it("accepts a consistent read only on a store read", () => {
    const cache = mutate("updateStep", { operation: "redirect", stepId: "get", consistent: true });
    const store = mutate("updateStep", { operation: "redirect", stepId: "read", consistent: true });

    expect(codes(cache)).toContain("step-unexpected-param");
    expect(codes(store)).not.toContain("step-unexpected-param");
  });

  it("accepts a TTL on a write only where the store expires entries", () => {
    const read = mutate("updateStep", { operation: "redirect", stepId: "read", ttlSec: 60 });
    const insert = applyCommand(asyncAttempt(), "updateStep", {
      operation: "create-link",
      stepId: "insert",
      ttlSec: 60,
    }).attempt;

    // Store reads take no TTL at all; the test PostgreSQL expires nothing.
    expect(codes(read)).toContain("step-unexpected-param");
    expect(codes(insert)).toContain("step-ttl-unsupported");
  });

  it("rejects exactly-once commits outside a stream processor", () => {
    let attempt = mutate("setComponentData", { id: "db", entities: ["Link", "LinkStats"] });
    attempt = mutate(
      "addStep",
      {
        operation: "redirect",
        id: "count",
        step: {
          type: "call",
          target: "db",
          action: "counter.increment",
          entity: "LinkStats",
          exactlyOnce: true,
        },
        attach: { to: "outcome", stepId: "expiryHit", outcome: "valid" },
        continueWith: { outcome: "ok" },
      },
      attempt,
    );

    expect(codes(attempt)).toContain("step-exactly-once-unsupported");
  });

  it("rejects an outbox publish reached from a write that failed", () => {
    const outbox = applyCommand(asyncAttempt(), "updateStep", {
      operation: "create-link",
      stepId: "publish",
      outbox: true,
    }).attempt;
    const afterError = applyCommand(outbox, "linkOutcome", {
      operation: "create-link",
      stepId: "insert",
      outcome: "error",
      target: "publish",
    }).attempt;

    expect(codes(afterError)).toContain("step-outbox-without-transaction");
  });

  it("rejects a request waiting for other requests to fill a batch", () => {
    const attempt = mutate("updateStep", { operation: "redirect", stepId: "read", batchSize: 10 });

    expect(codes(attempt)).toContain("step-batch-in-request");
  });

  it("accepts a request batching its own fan-out", () => {
    let attempt = mutate("updateStep", { operation: "redirect", stepId: "read", batchSize: 10 });
    attempt = mutate(
      "updateStep",
      { operation: "redirect", stepId: "read", each: "followees" },
      attempt,
    );
    const problem = {
      ...testProblem,
      counts: [{ id: "followees", label: "followees", default: 200 }],
    };

    expect(
      validateAttempt(attempt, { catalog: testCatalogIndex, problem }).map((i) => i.code),
    ).not.toContain("step-batch-in-request");
  });

  it("rejects a batch size on actions that take none", () => {
    const attempt = mutate("updateStep", {
      operation: "redirect",
      stepId: "populate",
      batchSize: 10,
    });

    expect(codes(attempt)).not.toContain("step-unexpected-param");
    const negative = mutate("updateStep", {
      operation: "redirect",
      stepId: "get",
      action: "cache.delete",
    });
    expect(
      codes(mutate("updateStep", { operation: "redirect", stepId: "get", batchSize: 5 }, negative)),
    ).toContain("step-unexpected-param");
  });

  it("accepts id allocation without an entity", () => {
    let attempt = mutate("addComponent", {
      id: "kgs",
      kind: "id-generator",
      flavor: "kgs",
      label: "KGS",
      size: "m",
      replicas: 2,
      position: { x: 0, y: 0 },
    });
    attempt = mutate("addConnection", { from: "api", to: "kgs" }, attempt);
    attempt = mutate("createFlow", { operation: "create-link", handler: "api" }, attempt);
    attempt = mutate(
      "addStep",
      {
        operation: "create-link",
        step: { type: "call", target: "kgs", action: "ids.allocate", batchSize: 1000 },
        attach: { to: "root" },
      },
      attempt,
    );

    const errors = validateAttempt(attempt, ctx).filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("rejects an entity on id allocation", () => {
    const raw = JSON.parse(JSON.stringify(createLinkAttempt("kgs")));
    raw.flows.find((f: { operation: string }) => f.operation === "create-link").steps.gen.entity =
      "Link";

    expect(codes(raw)).toContain("step-unexpected-param");
  });

  it("rejects decisions that the problem does not define", () => {
    const attempt = mutate("setDecision", { decision: "redirect-status", option: "s307" });

    expect(codes(attempt)).toContain("decision-unknown-option");
  });
});

describe("validateAttempt for asynchronous work", () => {
  const errors = (attempt: Attempt) =>
    validateAttempt(attempt, ctx).filter((i) => i.severity === "error");

  it("accepts a consumer of a published event and a scheduled job", () => {
    expect(errors(asyncAttempt())).toEqual([]);
  });

  it("accepts matching a local threat list from an API that provides the lists", () => {
    expect(errors(asyncAttempt({ localList: true }))).toEqual([]);
  });

  it("asks for an API that provides threat lists before matching against a local copy", () => {
    const attempt = mutate(
      "updateComponent",
      { id: "safety", flavor: "url-safety" },
      asyncAttempt({ localList: true }),
    );

    const issue = errors(attempt).find((i) => i.code === "step-logic-needs-component");
    expect(issue?.location).toEqual({ type: "step", operation: "scan-link", stepId: "match" });
    expect(issue?.message).toMatch(/needs a URL-safety API that provides threat lists.*"Worker"/);
  });

  it("asks a consumer to connect to a queue that receives its event", () => {
    const attempt = mutate("removeConnection", { id: "worker--queue" }, asyncAttempt());

    const issue = validateAttempt(attempt, ctx).find((i) => i.code === "flow-consumer-idle");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toMatch(/receives no link-created messages/);
  });

  it("does not let a consumer receive an event that nobody publishes", () => {
    const attempt = mutate(
      "removeStep",
      { operation: "create-link", stepId: "publish", bypass: "ok" },
      asyncAttempt(),
    );

    expect(codes(attempt)).toContain("flow-consumer-idle");
  });

  it("rejects publishing an event the problem does not define", () => {
    const attempt = mutate(
      "updateStep",
      { operation: "create-link", stepId: "publish", event: "link-deleted" },
      asyncAttempt(),
    );

    expect(codes(attempt)).toContain("step-unknown-event");
  });

  it("requires a publish step to name its event", () => {
    const raw = JSON.parse(JSON.stringify(asyncAttempt()));
    delete raw.flows.find((f: { operation: string }) => f.operation === "create-link").steps.publish
      .event;

    expect(codes(raw)).toContain("step-missing-param");
  });

  it("lets jobs collect batches but not requests, which cannot wait for each other", () => {
    const job = mutate(
      "updateStep",
      { operation: "purge-expired", stepId: "delete", batchSize: 100 },
      asyncAttempt(),
    );
    let request = mutate("createFlow", { operation: "disable-link", handler: "api" }, job);
    request = mutate(
      "addStep",
      {
        operation: "disable-link",
        step: { type: "call", target: "db", action: "store.delete", entity: "Link", batchSize: 10 },
        attach: { to: "root" },
      },
      request,
    );

    expect(codes(job)).not.toContain("step-batch-in-request");
    expect(codes(request)).toContain("step-batch-in-request");
  });

  it("drops the event when a publish step switches to another action", () => {
    const attempt = mutate(
      "updateStep",
      { operation: "create-link", stepId: "publish", action: "cache.delete", entity: "Link" },
      asyncAttempt(),
    );
    const step = attempt.flows.find((f) => f.operation === "create-link")?.steps.publish;

    expect(step?.type === "call" && step.event).toBeUndefined();
  });
});
