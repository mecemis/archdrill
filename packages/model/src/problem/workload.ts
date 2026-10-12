import { z } from "zod";
import { CapabilitySchema } from "../catalog/capabilities";
import { IdSchema } from "../catalog/schema";

export const ZipfSchema = z.object({
  distribution: z.literal("zipf"),
  /** Skew; around 1 for web traffic. */
  s: z.number().positive(),
  /** Number of distinct keys. */
  population: z.number().positive(),
});
export type Zipf = z.infer<typeof ZipfSchema>;

/**
 * A kind of request with its own facts. Outcomes are decided by these facts,
 * so correlations hold: a code that does not exist always misses the cache
 * (unless negatively cached) and is never found in the store.
 */
export const RequestClassSchema = z
  .object({
    id: IdSchema,
    share: z.number().min(0).max(1),
    /** The entity the request refers to exists. */
    exists: z.boolean().default(true),
    expired: z.boolean().default(false),
    disabled: z.boolean().default(false),
    /** The request carries invalid input (e.g. a malformed URL). */
    invalidInput: z.boolean().default(false),
    /** The request asks for a specific alias instead of a generated code. */
    customAlias: z.boolean().default(false),
    /** The requested alias is already taken. */
    aliasTaken: z.boolean().default(false),
    /** Every request of this class asks for the same key, such as a link that went viral. */
    hotKey: z.boolean().default(false),
  })
  .refine((cls) => cls.customAlias || !cls.aliasTaken, {
    message: "aliasTaken only applies to requests with customAlias",
    path: ["aliasTaken"],
  });
export type RequestClass = z.infer<typeof RequestClassSchema>;

const SHARE_TOLERANCE = 1e-9;

export const OperationWorkloadSchema = z
  .object({
    /** Entity whose keys the requests address; key popularity comes from `keys`. */
    entity: z.string().min(1),
    classes: z.array(RequestClassSchema).min(1),
  })
  .refine((w) => Math.abs(w.classes.reduce((sum, c) => sum + c.share, 0) - 1) < SHARE_TOLERANCE, {
    message: "request class shares must sum to 1",
    path: ["classes"],
  });
export type OperationWorkload = z.infer<typeof OperationWorkloadSchema>;

export const KeyPopularitySchema = z.object({
  /** Popularity of keys that exist. */
  existing: ZipfSchema,
  /** Popularity of keys that do not exist (typos, scans); omit if they never repeat. */
  absent: ZipfSchema.optional(),
});

/**
 * Which components a fault hits, by role rather than by id, so a scenario
 * works with any design. A component must match every field given.
 */
export const ComponentSelectorSchema = z
  .strictObject({
    capability: CapabilitySchema.optional(),
    kind: IdSchema.optional(),
    /** The service that handles this operation. */
    handlerOf: IdSchema.optional(),
    /** Stores bound to this entity. */
    holds: z.string().min(1).optional(),
  })
  .refine((s) => Object.values(s).some((v) => v !== undefined), {
    message: "a selector needs at least one field",
  });
export type ComponentSelector = z.infer<typeof ComponentSelectorSchema>;

/** How calls to a failed component fail: refused at once, or hanging until the caller gives up. */
const FailureModeSchema = z.enum(["crash", "hang"]);

/**
 * Something going wrong in an environment.
 * - `down`: the whole component (`all`), one instance (`one-node`, survived
 *   by replicas) or one shard with all its replicas (`one-shard`) fails.
 * - `slow`: service time multiplied by `factor`, so capacity divides by it.
 * - `degraded`: capacity multiplied by `capacity`.
 * - `failover`: a store's primary is lost and a replica is being promoted.
 *   Writes to that shard fail; reads continue on replicas.
 */
export const FaultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("down"),
    target: ComponentSelectorSchema,
    mode: FailureModeSchema.default("crash"),
    scope: z.enum(["all", "one-node", "one-shard"]).default("all"),
  }),
  z.strictObject({
    kind: z.literal("slow"),
    target: ComponentSelectorSchema,
    factor: z.number().min(1).max(1000),
  }),
  z.strictObject({
    kind: z.literal("degraded"),
    target: ComponentSelectorSchema,
    capacity: z.number().gt(0).max(1),
  }),
  z.strictObject({
    kind: z.literal("failover"),
    target: ComponentSelectorSchema,
    mode: FailureModeSchema.default("hang"),
  }),
]);
export type Fault = z.infer<typeof FaultSchema>;

export const EnvironmentSchema = z.object({
  id: IdSchema,
  label: z.string().min(1),
  /** What the environment represents, shown next to its metrics. */
  description: z.string().min(1).optional(),
  /** Requests per second per operation. */
  rates: z.record(IdSchema, z.number().nonnegative()),
  faults: z.array(FaultSchema).default([]),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const WorkloadSchema = z.object({
  operations: z.record(IdSchema, OperationWorkloadSchema),
  keys: z.record(z.string().min(1), KeyPopularitySchema),
  /** Number of stored entities per entity type, for storage cost and capacity. */
  dataset: z.record(z.string().min(1), z.number().nonnegative()).default({}),
  /**
   * Keyspace of generated codes per entity: alphabet size and the decision
   * that sets the code length. Random codes collide with probability
   * stored / alphabet^length.
   */
  keyspace: z
    .record(
      z.string().min(1),
      z.object({ alphabet: z.number().int().min(2), lengthDecision: IdSchema }),
    )
    .default({}),
  /**
   * The decision that sets how stores with a primary replicate writes:
   * `async`, `semi-sync` or `sync`. Waiting for replicas adds latency to writes.
   */
  replication: z.object({ decision: IdSchema }).optional(),
  environments: z.array(EnvironmentSchema).min(1),
});

/** Options a replication decision may offer. */
export const REPLICATION_MODES = ["async", "semi-sync", "sync"] as const;
export type ReplicationMode = (typeof REPLICATION_MODES)[number];
export type Workload = z.infer<typeof WorkloadSchema>;
