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
  | "aggregateSec"
  | "counterShards"
  | "fireAndForget"
  | "bufferSize";

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
    description:
      "Look up an entity by key in the cache. A negative hit means the cache remembers that the key does not exist.",
  },
  "cache.set": {
    label: "set",
    capability: "volatile-kv",
    effect: "populate",
    outcomes: ["ok", "error"],
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
    params: [],
    description: "Remove an entity from the cache.",
  },
  "store.read": {
    label: "read",
    capability: "durable-store",
    effect: "read",
    outcomes: ["found", "notFound", "error"],
    params: [],
    optionalParams: ["coalesce"],
    description:
      "Read an entity by key from a durable store. With coalescing (single-flight), concurrent reads of the same key in one instance share one call.",
  },
  "store.insert": {
    label: "put",
    capability: "durable-store",
    effect: "write",
    outcomes: ["ok", "error"],
    params: [],
    optionalParams: ["aggregateSec", "batchSize"],
    description:
      "Writes the entity by key, overwriting whatever is there (like DynamoDB PutItem or an upsert). Two concurrent writers with the same key silently overwrite each other. With an aggregation window (in consumers), the handler sums what arrives for a key over the window and writes the window's total under the key and the window, once: writing it again writes the same total. With a batch size (in consumers), that many rows go in one call.",
  },
  "store.insertIfAbsent": {
    label: "insert if absent",
    capability: "conditional-write",
    effect: "conditional-write",
    outcomes: ["ok", "conflict", "error"],
    params: [],
    description: "Atomic insert that fails with a conflict when the key already exists.",
    unsafeToRetry:
      "A timed-out insert may still have written the row. The retry then finds the key taken and reports a conflict for the caller's own write.",
  },
  "store.update": {
    label: "update",
    capability: "durable-store",
    effect: "write",
    outcomes: ["ok", "notFound", "error"],
    params: [],
    description: "Update an existing entity by key.",
  },
  "store.delete": {
    label: "delete",
    capability: "durable-store",
    effect: "delete",
    outcomes: ["ok", "error"],
    params: [],
    optionalParams: ["batchSize"],
    description:
      "Delete an entity by key. With a batch size (for background jobs), one call deletes that many entities.",
  },
  "queue.publish": {
    label: "publish",
    capability: "async-buffer",
    effect: "publish",
    outcomes: ["ok", "error"],
    params: ["event"],
    optionalParams: ["fireAndForget", "bufferSize", "batchSize"],
    description:
      "Publish a message about an event to a queue and continue without waiting for consumers. Delivery is at least once: a consumer can see a message twice. Fire-and-forget hands the message to a local buffer and continues at once: the request never waits for the queue or fails with it, and while the queue is unreachable the buffer holds messages up to its size and drops the rest. With a batch size, the buffer sends that many messages in one call.",
  },
  "counter.increment": {
    label: "increment",
    capability: "atomic-increment",
    effect: "increment",
    outcomes: ["ok", "error"],
    params: [],
    optionalParams: ["aggregateSec", "counterShards", "batchSize"],
    description:
      "Atomically add to a count stored under the entity's key. With an aggregation window (in consumers), the handler sums increments per key over the window and adds each sum once. With counter shards, one key's count is spread over that many rows, so a hot key's writes spread too; reading the count adds them up. With a batch size (in consumers), that many increments go in one call.",
    unsafeToRetry:
      "A timed-out increment may have been applied. Retrying it, or redelivering its message, counts the same thing twice.",
  },
  "service.call": {
    label: "call",
    capability: "stateless-compute",
    effect: "read",
    outcomes: ["ok", "error"],
    params: [],
    description:
      "Call another service's API and wait for its answer, for example to hand an allowed request to the backend that does the work.",
  },
  "external.check": {
    label: "check URL",
    capability: "external",
    effect: "read",
    outcomes: ["clean", "malicious", "error"],
    params: [],
    optionalParams: ["batchSize"],
    decidedBy: { fact: "malicious", outcome: "malicious" },
    description:
      "Ask an external URL-safety service whether a URL is malicious. It has a request quota; with a batch size, one call checks that many URLs.",
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
