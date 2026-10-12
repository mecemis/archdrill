import { z } from "zod";
import { ActionIdSchema } from "../catalog/actions";
import { LogicIdSchema } from "../catalog/logic";
import { IdSchema } from "../catalog/schema";
import { HttpStatusSchema } from "../problem/schema";

export const ATTEMPT_SCHEMA_VERSION = 1;
/** Upper bounds that keep imported designs within what the model is calibrated for. */
export const MAX_REPLICAS = 1000;
export const MAX_SHARDS = 1024;

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
  /** Entities this component stores (durable stores only). */
  data: z.array(DataBindingSchema).default([]),
});
export type Component = z.infer<typeof ComponentSchema>;

export const ConnectionSchema = z.object({
  id: IdSchema,
  from: IdSchema,
  to: IdSchema,
  mode: z.enum(["sync", "async"]).default("sync"),
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
    layout: {},
  };
}
