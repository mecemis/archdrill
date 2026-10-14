import type { Attempt } from "../attempt/schema";
import { applyCommand, type CommandArgs, type CommandName } from "../commands/index";
import { createLinkAttempt } from "./write-path";

function step<N extends CommandName>(attempt: Attempt, name: N, args: CommandArgs<N>): Attempt {
  return applyCommand(attempt, name, args).attempt;
}

export interface AsyncOptions {
  /** Worker instances (size m: 3,000 calls per second each). */
  readonly workers?: number;
  /** Batch size of the purge job's deletes. */
  readonly purgeBatch?: number;
  /** Match URLs against local threat lists first, and confirm only matches with the API. */
  readonly localList?: boolean;
}

/**
 * The KGS create path publishes link-created after the insert. A worker
 * consumes it from a queue, checks the URL with a URL-safety API (or, with a
 * local list, matches it locally and confirms only matches), disables and
 * evicts a malicious link, and answers 503 on errors so the message is
 * delivered again. The same worker purges expired links.
 */
export function asyncAttempt({
  workers = 2,
  purgeBatch,
  localList = false,
}: AsyncOptions = {}): Attempt {
  let a = createLinkAttempt("kgs", 100);
  const component = (id: string, kind: string, flavor: string, label: string, size: string) => {
    a = step(a, "addComponent", { id, kind, flavor, label, size, position: { x: 0, y: 0 } });
  };
  component("queue", "queue", "managed-queue", "Link events", "m");
  component("worker", "service", "generic", "Worker", "m");
  component(
    "safety",
    "external-api",
    localList ? "url-safety-list" : "url-safety",
    "URL safety",
    "quota",
  );
  a = step(a, "updateComponent", { id: "worker", replicas: workers });
  for (const [from, to] of [
    ["api", "queue"],
    ["worker", "queue"],
    ["worker", "safety"],
    ["worker", "db"],
    ["worker", "redis"],
  ] as const) {
    a = step(a, "addConnection", { from, to });
  }
  a = step(a, "addStep", {
    operation: "create-link",
    id: "publish",
    step: { type: "call", target: "queue", action: "queue.publish", event: "link-created" },
    attach: { to: "outcome", stepId: "insert", outcome: "ok" },
    continueWith: { outcome: "ok" },
  });
  a = step(a, "linkOutcome", {
    operation: "create-link",
    stepId: "insert-alias",
    outcome: "ok",
    target: "publish",
  });
  a = step(a, "linkOutcome", {
    operation: "create-link",
    stepId: "publish",
    outcome: "error",
    target: "r503",
  });

  a = step(a, "createFlow", { operation: "scan-link", handler: "worker" });
  const scan = (
    id: string,
    input: CommandArgs<"addStep">["step"],
    attach: CommandArgs<"addStep">["attach"],
  ) => {
    a = step(a, "addStep", { operation: "scan-link", id, step: input, attach });
  };
  const at = (stepId: string, outcome: string) => ({ to: "outcome" as const, stepId, outcome });
  scan("check", { type: "call", target: "safety", action: "external.check" }, { to: "root" });
  scan("done", { type: "respond", status: 200 }, at("check", "clean"));
  scan("retry", { type: "respond", status: 503 }, at("check", "error"));
  scan(
    "disable",
    { type: "call", target: "db", action: "store.update", entity: "Link" },
    at("check", "malicious"),
  );
  scan(
    "evict",
    { type: "call", target: "redis", action: "cache.delete", entity: "Link" },
    at("disable", "ok"),
  );
  for (const [stepId, outcome, target] of [
    ["disable", "notFound", "done"],
    ["disable", "error", "retry"],
    ["evict", "ok", "done"],
    ["evict", "error", "retry"],
  ] as const) {
    a = step(a, "linkOutcome", { operation: "scan-link", stepId, outcome, target });
  }
  if (localList) {
    a = step(a, "addStep", {
      operation: "scan-link",
      id: "match",
      step: { type: "logic", logic: "matchThreatList" },
      attach: { to: "root" },
      continueWith: { outcome: "match" },
    });
    a = step(a, "linkOutcome", {
      operation: "scan-link",
      stepId: "match",
      outcome: "clean",
      target: "done",
    });
  }

  a = step(a, "createFlow", { operation: "purge-expired", handler: "worker" });
  a = step(a, "addStep", {
    operation: "purge-expired",
    id: "delete",
    step: {
      type: "call",
      target: "db",
      action: "store.delete",
      entity: "Link",
      ...(purgeBatch ? { batchSize: purgeBatch } : {}),
    },
    attach: { to: "root" },
  });
  a = step(a, "addStep", {
    operation: "purge-expired",
    id: "done",
    step: { type: "respond", status: 200 },
    attach: { to: "outcome", stepId: "delete", outcome: "ok" },
  });
  a = step(a, "addStep", {
    operation: "purge-expired",
    id: "retry",
    step: { type: "respond", status: 503 },
    attach: { to: "outcome", stepId: "delete", outcome: "error" },
  });
  return a;
}
