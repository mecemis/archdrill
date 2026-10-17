import { z } from "zod";
import type { Capability } from "./capabilities";
import type { FactRule } from "./logic";

/** What an action does to data; dataflow facts are derived from this. */
export type ActionEffect =
  | "read"
  | "allocate"
  | "write"
  | "conditional-write"
  | "delete"
  | "populate"
  | "populate-negative"
  | "invalidate"
  | "publish"
  /** Adds to a stored count: applied twice, it counts twice, so it is not naturally idempotent. */
  | "increment";

/** Step parameters an action requires. */
export type ActionParam = "ttlSec" | "event";

/** Step parameters an action accepts but does not require. */
export type OptionalActionParam =
  | "batchSize"
  | "coalesce"
  | "consistent"
  | "homeRegion"
  | "aggregateSec"
  | "counterShards"
  | "fireAndForget"
  | "bufferSize"
  | "each"
  | "idempotencyKey"
  | "outbox"
  | "exactlyOnce"
  | "ttlSec";

export interface ActionDef {
  readonly label: string;
  readonly capability: Capability;
  readonly effect: ActionEffect;
  readonly outcomes: readonly string[];
  readonly params: readonly ActionParam[];
  readonly optionalParams?: readonly OptionalActionParam[];
  readonly description: string;
  /**
   * Why retrying this action after an ambiguous failure (a timeout) can
   * change what the caller sees. Absent for actions that are safe to retry.
   */
  readonly unsafeToRetry?: string;
  /**
   * For calls with two answers besides an error: the fact about the request
   * that decides which one a served call gives.
   */
  readonly decidedBy?: FactRule;
}

export const ACTIONS = {
  "cache.get": {
    label: "get",
    capability: "volatile-kv",
    effect: "read",
    outcomes: ["hit", "negativeHit", "miss", "error"],
    params: [],
    optionalParams: ["each", "batchSize"],
    description:
      "Look up an entity by key in the cache. A negative hit means the cache remembers that the key does not exist.",
  },
  "cache.set": {
    label: "set",
    capability: "volatile-kv",
    effect: "populate",
    outcomes: ["ok", "error"],
    optionalParams: ["each", "batchSize"],
    params: ["ttlSec"],
    description: "Store an entity in the cache with a time-to-live.",
  },
  "cache.setNegative": {
    label: "set negative",
    capability: "volatile-kv",
    effect: "populate-negative",
    outcomes: ["ok", "error"],
    params: ["ttlSec"],
    description: "Remember that a key does not exist, so repeated lookups skip the store.",
  },
  "cache.delete": {
    label: "delete",
    capability: "volatile-kv",
    effect: "invalidate",
    outcomes: ["ok", "error"],
    optionalParams: ["each"],
    params: [],
    description: "Remove an entity from the cache.",
  },
  "store.read": {
    label: "read",
    capability: "durable-store",
    effect: "read",
    outcomes: ["found", "notFound", "error"],
    params: [],
    optionalParams: ["coalesce", "consistent", "each", "batchSize"],
    description:
      "Read an entity by key from a durable store. With coalescing (single-flight), concurrent reads of the same key in one instance share one call. A consistent read sees every acknowledged write, at a price: only the primary serves it, or the store charges a full read unit.",
  },
  "store.insert": {
    label: "put",
    capability: "durable-store",
    effect: "write",
    outcomes: ["ok", "error"],
    params: [],
    optionalParams: ["aggregateSec", "batchSize", "each", "exactlyOnce", "homeRegion", "ttlSec"],
    description:
      "Writes the entity by key, overwriting whatever is there (like DynamoDB PutItem or an upsert). Two concurrent writers with the same key silently overwrite each other. With an aggregation window (in consumers), the handler sums what arrives for a key over the window and writes the window's total under the key and the window, once: writing it again writes the same total. With a batch size (in consumers), that many rows go in one call. With a TTL, a store that supports it deletes the entity when it expires.",
  },
  "store.insertIfAbsent": {
    label: "insert if absent",
    capability: "conditional-write",
    effect: "conditional-write",
    outcomes: ["ok", "conflict", "error"],
    params: [],
    optionalParams: ["homeRegion", "ttlSec"],
    description: "Atomic insert that fails with a conflict when the key already exists.",
    unsafeToRetry:
      "A timed-out insert may still have written the row. The retry then finds the key taken and reports a conflict for the caller's own write.",
  },
  "store.update": {
    label: "update",
    capability: "durable-store",
    effect: "write",
    outcomes: ["ok", "notFound", "error"],
    optionalParams: ["each", "homeRegion"],
    params: [],
    description: "Update an existing entity by key.",
  },
  "store.delete": {
    label: "delete",
    capability: "durable-store",
    effect: "delete",
    outcomes: ["ok", "error"],
    params: [],
    optionalParams: ["batchSize", "each"],
    description:
      "Delete an entity by key. With a batch size (for background jobs), one call deletes that many entities.",
  },
  "queue.publish": {
    label: "publish",
    capability: "async-buffer",
    effect: "publish",
    outcomes: ["ok", "error"],
    params: ["event"],
    optionalParams: ["fireAndForget", "bufferSize", "batchSize", "each", "outbox"],
    description:
      "Publish a message about an event to a queue and continue without waiting for consumers. Delivery is at least once: a consumer can see a message twice. Fire-and-forget hands the message to a local buffer and continues at once: the request never waits for the queue or fails with it, and while the queue is unreachable the buffer holds messages up to its size and drops the rest. With a batch size, the buffer sends that many messages in one call. Through a transactional outbox, the message is written in the same transaction as the store write before it and relayed afterwards: it is published if and only if that write committed.",
  },
  "counter.increment": {
    label: "increment",
    capability: "atomic-increment",
    effect: "increment",
    outcomes: ["ok", "error"],
    params: [],
    optionalParams: ["aggregateSec", "counterShards", "batchSize", "each", "exactlyOnce"],
    description:
      "Atomically add to a count stored under the entity's key. With an aggregation window (in consumers), the handler sums increments per key over the window and adds each sum once. With counter shards, one key's count is spread over that many rows, so a hot key's writes spread too; reading the count adds them up. With a batch size (in consumers), that many increments go in one call. Committed with a stream processor's checkpoints (exactly once), a replay after a restart does not repeat it.",
    unsafeToRetry:
      "A timed-out increment may have been applied. Retrying it, or redelivering its message, counts the same thing twice.",
  },
  "service.call": {
    label: "call",
    capability: "stateless-compute",
    effect: "read",
    outcomes: ["ok", "error"],
    optionalParams: ["each"],
    params: [],
    description:
      "Call another service's API and wait for its answer, for example to hand an allowed request to the backend that does the work.",
  },
  "connection.push": {
    label: "push",
    capability: "persistent-connections",
    effect: "write",
    outcomes: ["ok", "error"],
    params: [],
    optionalParams: ["each", "batchSize"],
    description:
      "Send a frame to a connected client over the connection it holds open with a gateway, for example a new message.",
  },
  "external.notify": {
    label: "send push notification",
    capability: "push-notifications",
    effect: "publish",
    outcomes: ["ok", "error"],
    params: [],
    optionalParams: ["each"],
    description:
      "Ask a mobile push service to notify a device that is not connected. Every device is one message against the provider's quota: there is no multicast, and SDK helpers that take many devices send one message each.",
  },
  "external.charge": {
    label: "charge",
    capability: "payments",
    effect: "write",
    outcomes: ["approved", "declined", "error"],
    params: [],
    optionalParams: ["idempotencyKey"],
    description:
      "Ask a payment provider to charge the customer's card. With an idempotency key, the provider charges a repeated request only once and returns the first answer.",
    unsafeToRetry:
      "A timed-out charge may have gone through. Retried without an idempotency key, it charges the customer twice.",
    decidedBy: { fact: "cardDeclined", outcome: "declined" },
  },
  "external.refund": {
    label: "refund",
    capability: "payments",
    effect: "write",
    outcomes: ["ok", "error"],
    params: [],
    optionalParams: ["idempotencyKey"],
    description:
      "Ask the payment provider to refund a charge, for example when the order cannot be confirmed.",
    unsafeToRetry:
      "A timed-out refund may have gone through. Retried without an idempotency key, it refunds twice.",
  },
  "payments.lookup": {
    label: "look up payment",
    capability: "payments",
    effect: "read",
    outcomes: ["found", "notFound", "error"],
    params: [],
    optionalParams: ["batchSize"],
    description:
      "Ask the payment provider what it recorded for an order (charged or not), for example to settle orders whose charge timed out.",
  },
  "external.check": {
    label: "check URL",
    capability: "external",
    effect: "read",
    outcomes: ["clean", "malicious", "error"],
    params: [],
    decidedBy: { fact: "malicious", outcome: "malicious" },
    description:
      "Ask a URL-safety API whether a URL is malicious. Each call checks one URL, counts against the project's quota and is billed.",
  },
  "ids.allocate": {
    label: "allocate id",
    capability: "id-generation",
    effect: "allocate",
    outcomes: ["ok", "error"],
    params: [],
    optionalParams: ["batchSize"],
    description:
      "Take a unique key from an id generator (for example a key generation service with pre-generated random keys). With a batch size, the handler takes keys in batches and calls the generator once per batch.",
  },
  "coord.leaseRange": {
    label: "lease id range",
    capability: "leases",
    effect: "allocate",
    outcomes: ["ok", "error"],
    params: [],
    optionalParams: ["batchSize"],
    description:
      "Atomically claim the next range of a counter from a coordination service. With a batch size, one call yields that many sequential ids.",
  },
} as const satisfies Record<string, ActionDef>;

export type ActionId = keyof typeof ACTIONS;
export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[];
export const ActionIdSchema = z.enum(ACTION_IDS as [ActionId, ...ActionId[]]);

export function getAction(id: ActionId): ActionDef {
  return ACTIONS[id];
}

/** Capabilities whose actions work on a problem entity (caches and stores). */
const ENTITY_CAPABILITIES: ReadonlySet<Capability> = new Set([
  "volatile-kv",
  "durable-store",
  "conditional-write",
  "atomic-increment",
]);

/** Whether a step with this action names the entity it works on. */
export function actionTakesEntity(id: ActionId): boolean {
  return ENTITY_CAPABILITIES.has(getAction(id).capability);
}

/** Whether a step with this action may carry the parameter (required or optional). */
export function actionTakesParam(id: ActionId, param: ActionParam | OptionalActionParam): boolean {
  const action = getAction(id);
  return (
    (action.params as readonly string[]).includes(param) ||
    (action.optionalParams ?? []).includes(param as OptionalActionParam)
  );
}

/**
 * Outcomes that can only happen when the design makes them possible. A cache
 * can only answer with a negative hit if some flow stores negative entries for
 * the same entity in the same cache.
 */
export const CONDITIONAL_OUTCOMES: Readonly<
  Partial<Record<ActionId, Readonly<Record<string, ActionId>>>>
> = {
  "cache.get": { negativeHit: "cache.setNegative" },
};
