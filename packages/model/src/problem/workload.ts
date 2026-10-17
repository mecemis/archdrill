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
    /** The request carries a malicious URL (phishing, malware) that a safety check flags. */
    malicious: z.boolean().default(false),
    /**
     * Other named facts about the request that decide logic steps and calls
     * (for example `overLimit` for a client above its rate limit).
     */
    facts: z.array(IdSchema).default([]),
    /** Counts that size fan-out steps, overriding the problem's defaults (`followers: 50000000`). */
    counts: z.record(IdSchema, z.number().min(0)).default({}),
  })
  .refine((cls) => cls.customAlias || !cls.aliasTaken, {
    message: "aliasTaken only applies to requests with customAlias",
    path: ["aliasTaken"],
  });
export type RequestClass = z.infer<typeof RequestClassSchema>;

/** Facts with a field of their own; every other fact is listed in `facts`. */
export const BUILT_IN_FACTS = [
  "exists",
  "expired",
  "disabled",
  "invalidInput",
  "customAlias",
  "aliasTaken",
  "hotKey",
  "malicious",
] as const satisfies readonly (keyof RequestClass)[];

/** Whether a fact holds for requests of this class. */
export function hasFact(cls: RequestClass, fact: string): boolean {
  if ((BUILT_IN_FACTS as readonly string[]).includes(fact)) {
    return cls[fact as (typeof BUILT_IN_FACTS)[number]] === true;
  }
  return cls.facts.includes(fact);
}

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
 * - `zone-down`: an availability zone is lost with every instance in it, in
 *   any component. Primaries there have failed over, and no instance has
 *   been launched to replace the lost ones yet.
 * - `region-down`: the primary region is lost with everything in it. DNS has
 *   sent traffic to the standby region, where components with a standby copy
 *   serve it; the rest are gone.
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
  z.strictObject({
    kind: z.literal("zone-down"),
    mode: FailureModeSchema.default("crash"),
  }),
  z.strictObject({
    kind: z.literal("region-down"),
    mode: FailureModeSchema.default("crash"),
  }),
]);
export type Fault = z.infer<typeof FaultSchema>;

/** A lost region and a lost zone are separate stories: the zone would be in the lost region. */
const ZONE_AND_REGION = "a lost zone and a lost region cannot be combined";

export const EnvironmentSchema = z.object({
  /** Clients holding a persistent connection (WebSockets), spread over the gateways that hold them. */
  connections: z.number().min(0).default(0),
  id: IdSchema,
  label: z.string().min(1),
  /** What the environment represents, shown next to its metrics. */
  description: z.string().min(1).optional(),
  /** Requests per second per operation. */
  rates: z.record(IdSchema, z.number().nonnegative()),
  /**
   * Request-class shares that differ from the workload's in this environment,
   * per operation (for example no viral link on an average day). Classes left
   * out keep their workload share; the result must still add up to 1.
   */
  classShares: z.record(IdSchema, z.record(IdSchema, z.number().min(0).max(1))).default({}),
  faults: z
    .array(FaultSchema)
    .default([])
    .refine(
      (faults) =>
        !(
          faults.some((f) => f.kind === "zone-down") && faults.some((f) => f.kind === "region-down")
        ),
      { message: ZONE_AND_REGION },
    ),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

/** Longest timeline, in seconds; longer runs show nothing new and cost evaluation time. */
export const MAX_TIMELINE_SEC = 1800;

/**
 * Something that happens at a moment of a timeline: the load moves to new
 * rates (at once, or over a ramp), or a fault starts and, optionally, ends.
 */
export const TimelineEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("load"),
    at: z.number().min(0),
    /** New requests (or job items) per second; operations left out keep their rate. */
    rates: z.record(IdSchema, z.number().nonnegative()),
    /** Seconds over which the rates move to the new values; 0 is a step. */
    rampSec: z.number().min(0).default(0),
    /**
     * How rates move over the ramp: in a straight line, or growing by the same
     * factor every second, as traffic does when a link spreads.
     */
    curve: z.enum(["linear", "exponential"]).default("linear"),
    label: z.string().min(1).optional(),
  }),
  z.strictObject({
    /** Components restart and lose what they hold in memory: a cache starts empty. */
    kind: z.literal("restart"),
    at: z.number().min(0),
    target: ComponentSelectorSchema,
    label: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("fault"),
    at: z.number().min(0),
    /**
     * When the fault ends. Without it, a failover lasts as long as the
     * store's failover takes (`failoverSec` in the catalog), or to the end
     * when no replica can take over or the catalog gives no time; other
     * faults last to the end of the timeline. A lost zone also fails over
     * the primaries that were in it, for as long. A lost region sends
     * traffic to the standby region once DNS fails over, and promotes the
     * standby copies of stores for as long as each takes; it never ends,
     * since failing back is not modelled.
     */
    until: z.number().positive().optional(),
    fault: FaultSchema,
    label: z.string().min(1).optional(),
  }),
]);
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

/** What a prediction is about, measured on the timeline once it has run. */
export const PredictionMeasureSchema = z.discriminatedUnion("kind", [
  /** The highest utilisation any selected component reaches. */
  z.strictObject({ kind: z.literal("peak-utilization"), target: ComponentSelectorSchema }),
  /** The lowest success rate of an operation, over the steps it has traffic. */
  z.strictObject({ kind: z.literal("lowest-success"), operation: IdSchema }),
  /** Seconds after `after` until an operation's success rate is back at `threshold` for good. */
  z.strictObject({
    kind: z.literal("recovery-seconds"),
    operation: IdSchema,
    threshold: z.number().gt(0).max(1),
    after: z.number().min(0),
  }),
]);
export type PredictionMeasure = z.infer<typeof PredictionMeasureSchema>;

/**
 * Predict, then reveal: a question the candidate answers before a timeline
 * runs. Options are ranges of the measure in increasing order, each up to
 * `below`; the last one takes everything above.
 */
export const PredictionSchema = z
  .object({
    id: IdSchema,
    question: z.string().min(1),
    measure: PredictionMeasureSchema,
    options: z
      .array(z.object({ id: IdSchema, label: z.string().min(1), below: z.number().optional() }))
      .min(2),
  })
  .superRefine((prediction, ctx) => {
    const bounds = prediction.options.map((o) => o.below);
    const last = bounds.length - 1;
    bounds.forEach((bound, i) => {
      if (i < last !== (bound !== undefined)) {
        ctx.addIssue({
          code: "custom",
          message: "every option but the last needs `below`; the last takes everything above",
          path: ["options", i, "below"],
        });
      }
      const previous = bounds[i - 1];
      if (i > 0 && bound !== undefined && previous !== undefined && bound <= previous) {
        ctx.addIssue({
          code: "custom",
          message: "option bounds must increase",
          path: ["options", i, "below"],
        });
      }
    });
  });
export type Prediction = z.infer<typeof PredictionSchema>;

/**
 * How a design behaves over time: the scenario's workload, starting at
 * `rates`, with load changes and faults at given moments. The engine works in
 * steps of `stepSec` seconds.
 */
export const TimelineSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    durationSec: z.number().positive().max(MAX_TIMELINE_SEC),
    stepSec: z.number().min(0.1).max(10).default(1),
    rates: z.record(IdSchema, z.number().nonnegative()),
    /** Clients holding persistent connections throughout the timeline. */
    connections: z.number().min(0).default(0),
    classShares: z.record(IdSchema, z.record(IdSchema, z.number().min(0).max(1))).default({}),
    events: z.array(TimelineEventSchema).default([]),
    /** Questions to answer before the timeline is revealed. */
    predictions: z.array(PredictionSchema).default([]),
  })
  .superRefine((timeline, ctx) => {
    const lost = (kind: Fault["kind"]) =>
      timeline.events.filter((e) => e.kind === "fault" && e.fault.kind === kind).length;
    if (lost("region-down") > 1) {
      ctx.addIssue({
        code: "custom",
        message: "a timeline loses the region at most once",
        path: ["events"],
      });
    }
    if (lost("region-down") > 0 && lost("zone-down") > 0) {
      ctx.addIssue({ code: "custom", message: ZONE_AND_REGION, path: ["events"] });
    }
    timeline.events.forEach((event, i) => {
      // The standby region keeps the traffic: failing back is not modelled.
      if (
        event.kind === "fault" &&
        event.fault.kind === "region-down" &&
        event.until !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: `event ${i} ends a lost region, but failing back to it is not modelled`,
          path: ["events", i, "until"],
        });
      }
      if (event.at > timeline.durationSec) {
        ctx.addIssue({
          code: "custom",
          message: `event ${i} starts after the timeline ends`,
          path: ["events", i, "at"],
        });
      }
      if (event.kind === "fault" && event.until !== undefined && event.until <= event.at) {
        ctx.addIssue({
          code: "custom",
          message: `event ${i} ends before it starts`,
          path: ["events", i, "until"],
        });
      }
    });
  });
export type Timeline = z.infer<typeof TimelineSchema>;

export const WorkloadSchema = z.object({
  operations: z.record(IdSchema, OperationWorkloadSchema),
  keys: z.record(z.string().min(1), KeyPopularitySchema).default({}),
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
  /**
   * The decision that sets whether the standby region also takes traffic:
   * `active-passive` (it waits) or `active-active` (both regions serve).
   */
  regionMode: z.object({ decision: IdSchema }).optional(),
  environments: z.array(EnvironmentSchema).min(1),
  /** How the design behaves over time; each runs separately from the environments. */
  timelines: z.array(TimelineSchema).default([]),
});

/** Options a replication decision may offer. */
export const REPLICATION_MODES = ["async", "semi-sync", "sync"] as const;
/** Options a region-mode decision may offer. */
export const REGION_MODES = ["active-passive", "active-active"] as const;
export type RegionMode = (typeof REGION_MODES)[number];
export type ReplicationMode = (typeof REPLICATION_MODES)[number];
export type Workload = z.infer<typeof WorkloadSchema>;
