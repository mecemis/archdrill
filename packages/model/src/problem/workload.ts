import { z } from "zod";
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

export const EnvironmentSchema = z.object({
  id: IdSchema,
  label: z.string().min(1),
  /** Requests per second per operation. */
  rates: z.record(IdSchema, z.number().nonnegative()),
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
  environments: z.array(EnvironmentSchema).min(1),
});
export type Workload = z.infer<typeof WorkloadSchema>;
