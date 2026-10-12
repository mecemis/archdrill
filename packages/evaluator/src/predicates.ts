import type { Path, PathStep } from "@archdrill/engine";
import {
  ACTIONS,
  type ActionEffect,
  ActionIdSchema,
  CapabilitySchema,
  LogicIdSchema,
  type Operation,
} from "@archdrill/model";
import { z } from "zod";

const oneOrMany = <T extends z.ZodType>(schema: T) =>
  z.union([schema, z.array(schema).min(1)]).transform((v) => (Array.isArray(v) ? v : [v]));

const EFFECTS = [
  "read",
  "allocate",
  "write",
  "conditional-write",
  "delete",
  "populate",
  "populate-negative",
  "invalidate",
] as const satisfies readonly ActionEffect[];

/** Matches one step of a path. Every given field must match; omitted fields match anything. */
export const StepMatcherSchema = z.strictObject({
  action: oneOrMany(ActionIdSchema).optional(),
  logic: oneOrMany(LogicIdSchema).optional(),
  capability: oneOrMany(CapabilitySchema).optional(),
  effect: oneOrMany(z.enum(EFFECTS)).optional(),
  entity: z.string().min(1).optional(),
  outcome: oneOrMany(z.string().min(1)).optional(),
  /** Matches allocation calls made once per batch (batch size above 1). */
  batched: z.boolean().optional(),
  /** Matches calls to components of these kinds, e.g. an in-process `near-cache`. */
  targetKind: oneOrMany(z.string().min(1)).optional(),
});
export type StepMatcher = z.output<typeof StepMatcherSchema>;

export type PathPredicate =
  | { readonly status: readonly number[] }
  | { readonly statusClass: "2xx" | "3xx" | "4xx" | "5xx" }
  | { readonly success: boolean }
  | { readonly unhandled: boolean }
  | { readonly hasStep: StepMatcher }
  /** Steps matching each matcher occur in this order (not necessarily adjacent). */
  | { readonly hasSequence: readonly StepMatcher[] }
  | { readonly not: PathPredicate }
  | { readonly all: readonly PathPredicate[] }
  | { readonly any: readonly PathPredicate[] };

export const PathPredicateSchema: z.ZodType<PathPredicate, unknown> = z.lazy(() =>
  z.union([
    z.strictObject({ status: z.array(z.number().int()).min(1) }),
    z.strictObject({ statusClass: z.enum(["2xx", "3xx", "4xx", "5xx"]) }),
    z.strictObject({ success: z.boolean() }),
    z.strictObject({ unhandled: z.boolean() }),
    z.strictObject({ hasStep: StepMatcherSchema }),
    z.strictObject({ hasSequence: z.array(StepMatcherSchema).min(2) }),
    z.strictObject({ not: PathPredicateSchema }),
    z.strictObject({ all: z.array(PathPredicateSchema).min(1) }),
    z.strictObject({ any: z.array(PathPredicateSchema).min(1) }),
  ]),
);

export function matchStep(step: PathStep, matcher: StepMatcher): boolean {
  if (matcher.outcome && !matcher.outcome.includes(step.outcome)) return false;
  if (step.kind === "logic") {
    const callOnly =
      matcher.action ||
      matcher.capability ||
      matcher.effect ||
      matcher.entity ||
      matcher.targetKind ||
      matcher.batched !== undefined;
    return !callOnly && (!matcher.logic || matcher.logic.includes(step.logic));
  }
  if (matcher.logic) return false;
  if (matcher.action && !matcher.action.includes(step.action)) return false;
  const action = ACTIONS[step.action];
  if (matcher.capability && !matcher.capability.includes(action.capability)) return false;
  if (matcher.effect && !matcher.effect.includes(action.effect)) return false;
  if (matcher.entity && matcher.entity !== step.entity) return false;
  if (matcher.batched !== undefined && matcher.batched !== (step.batchSize ?? 1) > 1) return false;
  if (matcher.targetKind && !matcher.targetKind.includes(step.targetKind)) return false;
  return true;
}

/** Terminal HTTP status of a path, or null when it ends at an unhandled outcome. */
export function pathStatus(path: Path): number | null {
  return path.terminal.kind === "respond" ? path.terminal.status : null;
}

/** True when the path ends with a status the operation counts as a correct answer. */
export function isSuccessPath(path: Path, operation: Operation): boolean {
  const status = pathStatus(path);
  return status !== null && operation.successStatuses.includes(status);
}

/** True when the path serves the resource itself (2xx or 3xx). */
export function servesResource(path: Path): boolean {
  const status = pathStatus(path);
  return status !== null && status >= 200 && status < 400;
}

export function evalPredicate(path: Path, predicate: PathPredicate, operation: Operation): boolean {
  if ("status" in predicate) {
    const status = pathStatus(path);
    return status !== null && predicate.status.includes(status);
  }
  if ("statusClass" in predicate) {
    const status = pathStatus(path);
    return status !== null && `${Math.floor(status / 100)}xx` === predicate.statusClass;
  }
  if ("success" in predicate) return isSuccessPath(path, operation) === predicate.success;
  if ("unhandled" in predicate) return (path.terminal.kind === "unhandled") === predicate.unhandled;
  if ("hasStep" in predicate) return path.steps.some((step) => matchStep(step, predicate.hasStep));
  if ("hasSequence" in predicate) {
    let next = 0;
    for (const step of path.steps) {
      const matcher = predicate.hasSequence[next];
      if (matcher && matchStep(step, matcher)) next++;
    }
    return next === predicate.hasSequence.length;
  }
  if ("not" in predicate) return !evalPredicate(path, predicate.not, operation);
  if ("all" in predicate) return predicate.all.every((p) => evalPredicate(path, p, operation));
  return predicate.any.some((p) => evalPredicate(path, p, operation));
}
