import { z } from "zod";
import { ActionIdSchema } from "../catalog/actions";
import { LogicIdSchema } from "../catalog/logic";
import { IdSchema } from "../catalog/schema";
import { HttpStatusSchema } from "../problem/schema";

export const ATTEMPT_SCHEMA_VERSION = 1;
/** Upper bounds that keep imported designs within what the model is calibrated for. */
export const MAX_REPLICAS = 1000;
export const MAX_SHARDS = 1024;
/** A region has at least three availability zones, so a design spreads over up to three. */
export const MAX_ZONES = 3;
/** A design runs in its primary region, and may keep a standby copy in a second one. */
export const MAX_REGIONS = 2;
/** The most I/Os a second any volume offers (RDS io2 Block Express). */
export const MAX_IOPS = 256_000;
export const MAX_TIMEOUT_MS = 60_000;
export const MAX_RETRIES = 10;
export const MAX_AGGREGATE_SEC = 3600;
export const MAX_BUFFER_MESSAGES = 100_000_000;
export const MAX_POOL_SIZE = 1000;

export const PositionSchema = z.object({ x: z.number(), y: z.number() });
export type Position = z.infer<typeof PositionSchema>;

export const DataBindingSchema = z.object({ entity: z.string().min(1) });

export const ComponentSchema = z.object({
  id: IdSchema,
  kind: IdSchema,
  flavor: IdSchema,
  label: z.string().min(1),
  size: IdSchema.optional(),
  replicas: z.number().int().min(1).max(MAX_REPLICAS).default(1),
  /** Number of shards for shardable kinds; each shard holds part of the data. */
  shards: z.number().int().min(1).max(MAX_SHARDS).default(1),
  /**
   * Availability zones its instances are spread over, evenly, each shard's
   * replicas in different zones first. A zone's outage takes the instances
   * in it. Managed offerings span zones on their own.
   */
  zones: z.number().int().min(1).max(MAX_ZONES).default(1),
  /**
   * Regions it runs in: 1, the primary region only, or 2, with a standby
   * copy in a second region that takes over when the primary region is
   * lost. The standby copy is placed like the primary one and runs its
   * minimum instances; stores replicate to it asynchronously.
   */
  regions: z.number().int().min(1).max(MAX_REGIONS).default(1),
  /**
   * Put the flavor's connection proxy in front of it (RDS Proxy), for stores
   * whose callers hold pools of connections.
   */
  proxy: z.boolean().default(false),
  /**
   * I/Os a second provisioned on each copy's volume, for stores that read
   * pages from one (RDS gp3 from 400 GiB). Without it, the volume has its
   * baseline for its size.
   */
  iops: z.number().int().positive().max(MAX_IOPS).optional(),
  /** Entities this component stores (durable stores only). */
  data: z.array(DataBindingSchema).default([]),
  /**
   * Scale out with load: `replicas` is the minimum, `max` the most instances,
   * and instances are added to keep utilisation near `targetUtilization`.
   */
  autoscale: z
    .object({
      max: z.number().int().min(1).max(MAX_REPLICAS),
      targetUtilization: z.number().min(0.2).max(0.95).default(0.7),
    })
    .optional(),
});
export type Component = z.infer<typeof ComponentSchema>;

/**
 * How a service treats its calls over a connection: give up after a timeout,
 * retry failed calls, stop calling a dependency that fails most calls (circuit
 * breaker), and cap the call rate (bulkhead). Only calls made by flow steps
 * follow these; ingress hops do not. Every hop between zones follows
 * `sameZone`.
 */
export const ConnectionPolicySchema = z.object({
  /** Give up on a call after this long. Without it, a hung call waits for the client default. */
  timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
  /** Extra attempts after a failed call (an error, a timeout or a rejection). */
  retries: z.number().int().min(0).max(MAX_RETRIES).default(0),
  /** Wait between attempts: none, or exponential from a few milliseconds. */
  backoff: z.enum(["none", "exponential"]).default("exponential"),
  /** Randomise the backoff so callers do not retry in lockstep. */
  jitter: z.boolean().default(true),
  /** Fail fast without calling while the dependency fails most calls. */
  circuitBreaker: z.boolean().default(false),
  /** Bulkhead: calls beyond this rate are rejected locally and never reach the target. */
  maxRps: z.number().positive().max(1e9).optional(),
  /**
   * Zone-aware routing: send calls to the target's instances in the caller's
   * zone, as far as that keeps them evenly loaded (a load balancer target
   * group without cross-zone load balancing, Kubernetes' PreferClose, Envoy's
   * zone-aware routing). A write still goes to its shard's primary, wherever
   * that is.
   */
  sameZone: z.boolean().default(false),
  /**
   * Connections each caller instance keeps open to every copy it calls of a
   * store that runs one statement per connection; 10 when not set, as in
   * HikariCP and node-postgres. A call waits for a free one.
   */
  poolSize: z.number().int().min(1).max(MAX_POOL_SIZE).optional(),
});
export type ConnectionPolicy = z.infer<typeof ConnectionPolicySchema>;
/** No timeout, no retries, no circuit breaker, no bulkhead. */
export const DEFAULT_POLICY: ConnectionPolicy = ConnectionPolicySchema.parse({});

/**
 * A link a component can call over. Whether a call waits for its answer is
 * the step's to say (fire-and-forget, outbox), not the connection's; designs
 * saved with a connection `mode` load with it dropped.
 */
export const ConnectionSchema = z.object({
  id: IdSchema,
  from: IdSchema,
  to: IdSchema,
  policy: ConnectionPolicySchema.prefault({}),
});
export type Connection = z.infer<typeof ConnectionSchema>;

/** Outcome name → id of the step that handles it. A missing outcome is unhandled. */
const NextSchema = z.record(z.string().min(1), IdSchema).default({});

export const CallStepSchema = z.object({
  type: z.literal("call"),
  target: IdSchema,
  action: ActionIdSchema,
  entity: z.string().min(1).optional(),
  ttlSec: z.number().int().positive().optional(),
  /** For allocation actions: how many ids one call yields, so only one request in a batch pays for the call. */
  batchSize: z.number().int().min(1).max(1_000_000).optional(),
  /** For publish steps: the event the message is about. */
  event: IdSchema.optional(),
  /** For store reads: concurrent reads of the same key in one instance share one call (single-flight). */
  coalesce: z.boolean().optional(),
  /**
   * For store reads: read the latest acknowledged write, from the primary
   * where replicas serve reads (or at a majority, for quorum stores), or as
   * a strongly consistent read where the store offers one. Without it, a
   * read may come from a replica that has not applied a recent write.
   */
  consistent: z.boolean().optional(),
  /**
   * For store writes, when both regions take traffic: send the write to the
   * primary region's copy, even from the other region, so that a conditional
   * write is checked in one place. Half the writes cross regions for it.
   */
  homeRegion: z.boolean().optional(),
  /** For counts and totals in consumers: sum what arrives per key over this many seconds, then write once. */
  aggregateSec: z.number().int().min(1).max(MAX_AGGREGATE_SEC).optional(),
  /** For increments: spread each key's count over this many rows. */
  counterShards: z.number().int().min(2).max(MAX_SHARDS).optional(),
  /** For publishes: hand the message to a local buffer and continue without waiting. */
  fireAndForget: z.boolean().optional(),
  /**
   * Make the call once for each of the request's items of this count (for
   * example `followers`), in parallel; the count comes from the request's class.
   */
  each: IdSchema.optional(),
  /** For payments: the request carries an idempotency key, so the provider acts on a repeat only once. */
  idempotencyKey: z.boolean().optional(),
  /**
   * For writes from a stream processor: committed together with its
   * checkpoint (two-phase commit), so a replay after a restart does not repeat them.
   */
  exactlyOnce: z.boolean().optional(),
  /** For publishes: through a transactional outbox, written with the store write before it. */
  outbox: z.boolean().optional(),
  /** For fire-and-forget publishes: messages held while the queue is unreachable. */
  bufferSize: z.number().int().min(1).max(MAX_BUFFER_MESSAGES).optional(),
  next: NextSchema,
});
export type CallStep = z.infer<typeof CallStepSchema>;

export const LogicStepSchema = z.object({
  type: z.literal("logic"),
  logic: LogicIdSchema,
  next: NextSchema,
});
export type LogicStep = z.infer<typeof LogicStepSchema>;

export const RespondStepSchema = z.object({
  type: z.literal("respond"),
  status: HttpStatusSchema,
});
export type RespondStep = z.infer<typeof RespondStepSchema>;

export const StepSchema = z.discriminatedUnion("type", [
  CallStepSchema,
  LogicStepSchema,
  RespondStepSchema,
]);
export type Step = z.infer<typeof StepSchema>;
export type BranchingStep = CallStep | LogicStep;

export const FlowSchema = z.object({
  operation: IdSchema,
  /** The service that receives the request and performs the steps. */
  handler: IdSchema,
  root: IdSchema.nullable().default(null),
  steps: z.record(IdSchema, StepSchema).default({}),
});
export type Flow = z.infer<typeof FlowSchema>;

export const ArchitectureSchema = z.object({
  components: z.array(ComponentSchema).default([]),
  connections: z.array(ConnectionSchema).default([]),
});
export type Architecture = z.infer<typeof ArchitectureSchema>;

export const AttemptSchema = z.object({
  schemaVersion: z.literal(ATTEMPT_SCHEMA_VERSION),
  problemId: IdSchema,
  problemVersion: z.number().int().positive(),
  architecture: ArchitectureSchema,
  flows: z.array(FlowSchema).default([]),
  decisions: z.record(IdSchema, IdSchema).default({}),
  /** The candidate's back-of-envelope answers, by estimate id, in base units. */
  estimates: z.record(IdSchema, z.number().positive()).default({}),
  /** Presentation only. Never read by analysis or evaluation. */
  layout: z.record(IdSchema, PositionSchema).default({}),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export function isBranchingStep(step: Step): step is BranchingStep {
  return step.type !== "respond";
}

export function emptyAttempt(problemId: string, problemVersion: number): Attempt {
  return {
    schemaVersion: ATTEMPT_SCHEMA_VERSION,
    problemId,
    problemVersion,
    architecture: { components: [], connections: [] },
    flows: [],
    decisions: {},
    estimates: {},
    layout: {},
  };
}
