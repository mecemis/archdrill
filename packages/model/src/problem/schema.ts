import { z } from "zod";
import { IdSchema } from "../catalog/schema";
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
});
export type Entity = z.infer<typeof EntitySchema>;

export const OperationSchema = z.object({
  id: IdSchema,
  label: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
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
    decisionPoints: z.array(DecisionPointSchema).default([]),
    scenarios: z.array(IdSchema).min(1),
  })
  .superRefine((problem, ctx) => {
    const requirementIds = new Set(problem.requirements.map((r) => r.id));
    uniqueBy(problem.requirements, (r) => r.id, "requirement", ["requirements"], ctx);
    uniqueBy(problem.entities, (e) => e.name, "entity", ["entities"], ctx);
    uniqueBy(problem.operations, (o) => o.id, "operation", ["operations"], ctx);
    uniqueBy(problem.decisionPoints, (d) => d.id, "decision point", ["decisionPoints"], ctx);
    problem.operations.forEach((op, i) => {
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
