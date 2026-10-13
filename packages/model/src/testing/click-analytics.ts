import type { Attempt } from "../attempt/schema";
import { applyCommand, type CommandArgs, type CommandName } from "../commands/index";
import { cacheAsideAttempt } from "./fixtures";

function step<N extends CommandName>(attempt: Attempt, name: N, args: CommandArgs<N>): Attempt {
  return applyCommand(attempt, name, args).attempt;
}

export interface ClickOptions {
  /** The redirect hands clicks to a local buffer instead of waiting for the queue. */
  readonly fireAndForget?: boolean;
  readonly bufferSize?: number;
  /** The worker sums clicks per link over this window before incrementing. */
  readonly aggregateSec?: number;
  readonly counterShards?: number;
  /** Where counts are kept. */
  readonly store?: "cassandra" | "dynamodb";
  /** Cassandra shards (each with three replicas). */
  readonly storeShards?: number;
  /** The worker records each click id once (in DynamoDB) before counting it. */
  readonly dedupe?: boolean;
}

/**
 * The cache-aside redirect publishes link-clicked before answering 302. A
 * worker consumes it from a queue and increments the link's count; on an
 * error it answers 503 so the message is delivered again.
 */
export function clickAnalyticsAttempt({
  fireAndForget = true,
  bufferSize = 10_000,
  aggregateSec,
  counterShards,
  store = "cassandra",
  storeShards = 2,
  dedupe = false,
}: ClickOptions = {}): Attempt {
  let a = cacheAsideAttempt();
  const component = (id: string, kind: string, flavor: string, label: string) => {
    a = step(a, "addComponent", { id, kind, flavor, label, position: { x: 0, y: 0 } });
  };
  component("clicks", "queue", "managed-queue", "Click events");
  component("counter", "service", "generic", "Click counter");
  a = step(a, "updateComponent", { id: "counter", replicas: 4 });
  if (store === "cassandra") {
    component("stats", "wide-column-db", "cassandra", "Click counts");
    a = step(a, "updateComponent", { id: "stats", replicas: 3, shards: storeShards });
  } else {
    component("stats", "key-value-db", "dynamodb", "Click counts");
  }
  a = step(a, "setComponentData", { id: "stats", entities: ["LinkStats"] });
  const connections: [string, string][] = [
    ["api", "clicks"],
    ["counter", "clicks"],
    ["counter", "stats"],
  ];
  if (dedupe) {
    component("seen", "key-value-db", "dynamodb", "Seen clicks");
    a = step(a, "setComponentData", { id: "seen", entities: ["Click"] });
    connections.push(["counter", "seen"]);
  }
  for (const [from, to] of connections) a = step(a, "addConnection", { from, to });

  a = step(a, "addStep", {
    operation: "redirect",
    id: "click",
    step: {
      type: "call",
      target: "clicks",
      action: "queue.publish",
      event: "link-clicked",
      ...(fireAndForget ? { fireAndForget, bufferSize } : {}),
    },
    attach: { to: "outcome", stepId: "expiryHit", outcome: "valid" },
    continueWith: { outcome: "ok" },
  });
  const links: [string, string, string][] = [
    ["populate", "ok", "click"],
    ["populate", "error", "click"],
  ];
  // A click the queue does not take still redirects.
  if (!fireAndForget) links.push(["click", "error", "r302"]);
  for (const [stepId, outcome, target] of links) {
    a = step(a, "linkOutcome", { operation: "redirect", stepId, outcome, target });
  }

  a = step(a, "createFlow", { operation: "record-click", handler: "counter" });
  const add = (
    id: string,
    input: CommandArgs<"addStep">["step"],
    attach: CommandArgs<"addStep">["attach"],
  ) => {
    a = step(a, "addStep", { operation: "record-click", id, step: input, attach });
  };
  const at = (stepId: string, outcome: string) => ({ to: "outcome" as const, stepId, outcome });
  const count = {
    type: "call" as const,
    target: "stats",
    action: "counter.increment" as const,
    entity: "LinkStats",
    ...(aggregateSec ? { aggregateSec } : {}),
    ...(counterShards ? { counterShards } : {}),
  };
  if (dedupe) {
    add(
      "seen",
      { type: "call", target: "seen", action: "store.insertIfAbsent", entity: "Click" },
      { to: "root" },
    );
    add("count", count, at("seen", "ok"));
    add("duplicate", { type: "respond", status: 200 }, at("seen", "conflict"));
    add("again", { type: "respond", status: 503 }, at("seen", "error"));
  } else {
    add("count", count, { to: "root" });
  }
  add("done", { type: "respond", status: 200 }, at("count", "ok"));
  add("retry", { type: "respond", status: 503 }, at("count", "error"));
  return a;
}
