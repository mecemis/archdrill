import { z } from "zod";
import { LogicIdSchema } from "../catalog/logic";
import { IdSchema } from "../catalog/schema";
import { EstimateSchema } from "./estimates";
import { WorkloadSchema } from "./workload";

export const HttpStatusSchema = z.number().int().min(100).max(599);

export const RequirementSchema = z.object({
  id: z.string().regex(/^(FR|NFR)-\d+$/, "requirement ids look like FR-1 or NFR-2"),
  kind: z.enum(["functional", "non-functional"]),
  text: z.string().min(1),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const EntitySchema = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "entity names are PascalCase"),
  key: z.string().min(1),
  fields: z.array(z.string().min(1)).min(1),
  avgBytes: z.number().int().positive(),
  /**
   * Kept only briefly (a rate counter, a block marker), so a store that keeps
   * data in memory only is a fine place for it.
   */
  ephemeral: z.boolean().default(false),
  /**
   * Entries exist only for requests with this fact: a block marker exists
   * only for clients over their limit. Without it, the request class's
   * `exists` decides.
   */
  existsFor: IdSchema.optional(),
  /**
   * Requests with this fact ask for one hot key of this entity, whatever
   * their own key: a celebrity's recent posts, read by millions of followers.
   */
  hotFor: IdSchema.optional(),
});
export type Entity = z.infer<typeof EntitySchema>;

/** Something that happens in the system and can be published to a queue, such as a link being created. */
export const EventSchema = z.object({
  id: IdSchema,
  label: z.string().min(1),
  entity: z.string().min(1),
});
export type ProblemEvent = z.infer<typeof EventSchema>;

/**
 * What starts an operation: a client request, a message about an event that
 * a consumer takes from a queue, or a schedule (a background job).
 */
export const TriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("request") }),
  z.object({ type: z.literal("event"), event: IdSchema }),
  z.object({ type: z.literal("schedule"), description: z.string().min(1) }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const OperationSchema = z.object({
  id: IdSchema,
  label: z.string().min(1),
  /** HTTP method and path, for operations that clients request. */
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  path: z.string().min(1).optional(),
  trigger: TriggerSchema.prefault({ type: "request" }),
  class: z.enum(["read", "write"]),
  idempotent: z.boolean(),
  /** Statuses that count as a correct answer for availability purposes. */
  successStatuses: z.array(HttpStatusSchema).min(1),
  requirements: z.array(z.string()).default([]),
  introducedIn: IdSchema.optional(),
});
export type Operation = z.infer<typeof OperationSchema>;

export const DecisionPointSchema = z
  .object({
    id: IdSchema,
    question: z.string().min(1),
    options: z.array(z.object({ id: IdSchema, label: z.string().min(1) })).min(2),
    requirements: z.array(z.string()).default([]),
    /** Option assumed until the candidate decides; used by the simulation for decisions that affect numbers. */
    default: IdSchema.optional(),
  })
  .refine((d) => d.default === undefined || d.options.some((o) => o.id === d.default), {
    message: "default must be one of the options",
    path: ["default"],
  });
export type DecisionPoint = z.infer<typeof DecisionPointSchema>;

export const ScaleItemSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  note: z.string().optional(),
});

export const ProblemSchema = z
  .object({
    id: IdSchema,
    version: z.number().int().positive(),
    title: z.string().min(1),
    levels: z.array(z.enum(["senior", "staff"])).min(1),
    brief: z.string().min(1),
    scale: z.array(ScaleItemSchema).default([]),
    requirements: z.array(RequirementSchema).min(1),
    entities: z.array(EntitySchema).min(1),
    operations: z.array(OperationSchema).min(1),
    events: z.array(EventSchema).default([]),
    decisionPoints: z.array(DecisionPointSchema).default([]),
    /** Where traffic comes from: the client a new design starts with. */
    client: z
      .object({ flavor: IdSchema, label: z.string().min(1) })
      .default({ flavor: "browser", label: "Visitors" }),
    /**
     * Counts that size fan-out steps (`each`): followers of a post's author,
     * accounts a reader follows. Request classes can override the default.
     */
    counts: z
      .array(
        z.object({
          id: IdSchema,
          label: z.string().min(1),
          default: z.number().min(0),
        }),
      )
      .default([]),
    /** Local decisions a handler can make in this problem; leave it out to offer every one. */
    logic: z.array(LogicIdSchema).optional(),
    /** Back-of-envelope questions for the estimation gym. */
    estimates: z.array(EstimateSchema).default([]),
    scenarios: z.array(IdSchema).min(1),
  })
  .superRefine((problem, ctx) => {
    const requirementIds = new Set(problem.requirements.map((r) => r.id));
    uniqueBy(problem.requirements, (r) => r.id, "requirement", ["requirements"], ctx);
    uniqueBy(problem.entities, (e) => e.name, "entity", ["entities"], ctx);
    uniqueBy(problem.operations, (o) => o.id, "operation", ["operations"], ctx);
    uniqueBy(problem.decisionPoints, (d) => d.id, "decision point", ["decisionPoints"], ctx);
    uniqueBy(problem.estimates, (e) => e.id, "estimate", ["estimates"], ctx);
    const events = new Set(problem.events.map((e) => e.id));
    const entities = new Set(problem.entities.map((e) => e.name));
    uniqueBy(problem.events, (e) => e.id, "event", ["events"], ctx);
    problem.events.forEach((event, i) => {
      if (!entities.has(event.entity)) {
        ctx.addIssue({
          code: "custom",
          message: `event "${event.id}" is about unknown entity "${event.entity}"`,
          path: ["events", i, "entity"],
        });
      }
    });
    problem.operations.forEach((op, i) => {
      if (op.trigger.type === "request" && (!op.method || !op.path)) {
        ctx.addIssue({
          code: "custom",
          message: `operation "${op.id}" is requested by clients, so it needs a method and a path`,
          path: ["operations", i],
        });
      }
      if (op.trigger.type === "event" && !events.has(op.trigger.event)) {
        ctx.addIssue({
          code: "custom",
          message: `operation "${op.id}" consumes unknown event "${op.trigger.event}"`,
          path: ["operations", i, "trigger", "event"],
        });
      }
      op.requirements.forEach((req, j) => {
        if (!requirementIds.has(req)) {
          ctx.addIssue({
            code: "custom",
            message: `operation "${op.id}" references unknown requirement "${req}"`,
            path: ["operations", i, "requirements", j],
          });
        }
      });
    });
  });
export type Problem = z.infer<typeof ProblemSchema>;

export const DIMENSIONS = [
  "correctness",
  "concurrency",
  "consistency",
  "durability",
  "latency",
  "scalability",
  "availability",
  "cache-efficiency",
  "cost",
  "security",
  "operability",
] as const;
export const DimensionSchema = z.enum(DIMENSIONS);
export type Dimension = z.infer<typeof DimensionSchema>;

export const CheckInstanceSchema = z.object({
  id: IdSchema,
  /** Id of the check implementation in the evaluator's library. */
  use: IdSchema,
  title: z.string().min(1),
  dimension: DimensionSchema,
  /** 0 makes the check advisory: reported, never scored. */
  weight: z.number().nonnegative().default(1),
  gate: z.boolean().default(false),
  severity: z.enum(["critical", "major", "minor"]).default("major"),
  signal: z.enum(["baseline", "senior", "staff"]).default("baseline"),
  requirements: z.array(z.string()).default([]),
  params: z.record(z.string(), z.unknown()).default({}),
  why: z.string().min(1),
  fix: z.string().min(1),
});
export type CheckInstance = z.infer<typeof CheckInstanceSchema>;

const WEIGHT_TOLERANCE = 1e-6;

export const ScenarioSchema = z
  .object({
    id: IdSchema,
    problemId: IdSchema,
    title: z.string().min(1),
    order: z.number().int().positive(),
    story: z.string().min(1),
    focusOperations: z.array(IdSchema).min(1),
    prerequisites: z.array(IdSchema).default([]),
    dimensions: z.partialRecord(DimensionSchema, z.number().positive()),
    checks: z.array(CheckInstanceSchema).min(1),
    hints: z.array(z.string().min(1)).default([]),
    debrief: z.string().optional(),
    /** Traffic the scenario simulates; required by metric checks. */
    workload: WorkloadSchema.optional(),
  })
  .superRefine((scenario, ctx) => {
    const weights = Object.values(scenario.dimensions);
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (Math.abs(total - 1) > WEIGHT_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        message: `dimension weights must sum to 1 (got ${total})`,
        path: ["dimensions"],
      });
    }
    uniqueBy(scenario.checks, (c) => c.id, "check", ["checks"], ctx);
    scenario.checks.forEach((check, i) => {
      if (check.signal === "baseline" && !(check.dimension in scenario.dimensions)) {
        ctx.addIssue({
          code: "custom",
          message: `check "${check.id}" uses dimension "${check.dimension}" that the scenario does not weight`,
          path: ["checks", i, "dimension"],
        });
      }
    });
  });
export type Scenario = z.infer<typeof ScenarioSchema>;

function uniqueBy<T>(
  items: readonly T[],
  key: (item: T) => string,
  label: string,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const k = key(item);
    if (seen.has(k)) {
      ctx.addIssue({ code: "custom", message: `duplicate ${label} "${k}"`, path: [...path, i] });
    }
    seen.add(k);
  });
}
