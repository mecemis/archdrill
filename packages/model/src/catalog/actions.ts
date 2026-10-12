import { z } from "zod";
import type { Capability } from "./capabilities";

/** What an action does to data; dataflow facts are derived from this. */
export type ActionEffect =
  | "read"
  | "write"
  | "conditional-write"
  | "delete"
  | "populate"
  | "populate-negative"
  | "invalidate";

/** Optional step parameters an action may require. */
export type ActionParam = "ttlSec";

export interface ActionDef {
  readonly label: string;
  readonly capability: Capability;
  readonly effect: ActionEffect;
  readonly outcomes: readonly string[];
  readonly params: readonly ActionParam[];
  readonly description: string;
}

export const ACTIONS = {
  "cache.get": {
    label: "get",
    capability: "volatile-kv",
    effect: "read",
    outcomes: ["hit", "miss", "error"],
    params: [],
    description: "Look up an entity by key in the cache.",
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
    description: "Read an entity by key from a durable store.",
  },
  "store.insert": {
    label: "insert",
    capability: "durable-store",
    effect: "write",
    outcomes: ["ok", "error"],
    params: [],
    description: "Unconditional insert. Does not guarantee uniqueness under concurrency.",
  },
  "store.insertIfAbsent": {
    label: "insert if absent",
    capability: "conditional-write",
    effect: "conditional-write",
    outcomes: ["ok", "conflict", "error"],
    params: [],
    description: "Atomic insert that fails with a conflict when the key already exists.",
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
    description: "Delete an entity by key.",
  },
} as const satisfies Record<string, ActionDef>;

export type ActionId = keyof typeof ACTIONS;
export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[];
export const ActionIdSchema = z.enum(ACTION_IDS as [ActionId, ...ActionId[]]);

export function getAction(id: ActionId): ActionDef {
  return ACTIONS[id];
}
