import type { Draft } from "immer";
import { z } from "zod";
import { type Flow, isBranchingStep, type Step } from "../attempt/schema";
import { stepOutcomes } from "../attempt/steps";
import { ActionIdSchema } from "../catalog/actions";
import { LogicIdSchema } from "../catalog/logic";
import { IdSchema } from "../catalog/schema";
import { HttpStatusSchema } from "../problem/schema";
import {
  CommandError,
  defineCommand,
  nextNumberedId,
  requireComponentIndex,
  requireFlow,
} from "./define";

export const StepInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("call"),
    target: IdSchema,
    action: ActionIdSchema,
    entity: z.string().min(1).optional(),
    ttlSec: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("logic"), logic: LogicIdSchema }),
  z.object({ type: z.literal("respond"), status: HttpStatusSchema }),
]);
export type StepInput = z.infer<typeof StepInputSchema>;

/** Where a new step goes: as the first step, or behind an outcome of an existing step. */
export const AttachSchema = z.discriminatedUnion("to", [
  z.object({ to: z.literal("root") }),
  z.object({ to: z.literal("outcome"), stepId: IdSchema, outcome: z.string().min(1) }),
]);

export const createFlow = defineCommand(
  z.object({ operation: IdSchema, handler: IdSchema }),
  (draft, { operation, handler }) => {
    if (draft.flows.some((f) => f.operation === operation)) {
      throw new CommandError(`A flow for "${operation}" already exists.`);
    }
    requireComponentIndex(draft, handler);
    draft.flows.push({ operation, handler, root: null, steps: {} });
  },
);

export const setFlowHandler = defineCommand(
  z.object({ operation: IdSchema, handler: IdSchema }),
  (draft, { operation, handler }) => {
    requireComponentIndex(draft, handler);
    requireFlow(draft, operation).handler = handler;
  },
);

export const removeFlow = defineCommand(
  z.object({ operation: IdSchema }),
  (draft, { operation }) => {
    requireFlow(draft, operation);
    draft.flows = draft.flows.filter((f) => f.operation !== operation);
  },
);

/**
 * Adds a step and attaches it. With `continueWith`, whatever previously sat at
 * the attachment point is re-attached behind the new step's given outcome,
 * which inserts the step in the middle of an existing flow.
 */
export const addStep = defineCommand(
  z.object({
    operation: IdSchema,
    id: IdSchema.optional(),
    step: StepInputSchema,
    attach: AttachSchema,
    continueWith: z.object({ outcome: z.string().min(1) }).optional(),
  }),
  (draft, args) => {
    const flow = requireFlow(draft, args.operation);
    const id = args.id ?? nextNumberedId("s", Object.keys(flow.steps), "");
    if (id in flow.steps) throw new CommandError(`Step "${id}" already exists.`);
    const step = toStep(args.step);
    const previous = currentAttachment(flow, args.attach);
    if (args.continueWith && previous !== undefined) {
      if (!isBranchingStep(step) || !stepOutcomes(step).includes(args.continueWith.outcome)) {
        throw new CommandError(`The new step has no outcome "${args.continueWith.outcome}".`);
      }
      step.next[args.continueWith.outcome] = previous;
    } else if (args.attach.to === "root" && previous !== undefined) {
      throw new CommandError("The flow already has a first step. Insert in front of it instead.");
    }
    flow.steps[id] = step;
    setAttachment(flow, args.attach, id);
    return id;
  },
);

export const updateStep = defineCommand(
  z.object({
    operation: IdSchema,
    stepId: IdSchema,
    entity: z.string().min(1).optional(),
    ttlSec: z.number().int().positive().nullable().optional(),
    status: HttpStatusSchema.optional(),
  }),
  (draft, args) => {
    const step = requireStep(requireFlow(draft, args.operation), args.stepId);
    if (step.type === "call") {
      if (args.entity !== undefined) step.entity = args.entity;
      if (args.ttlSec === null) delete step.ttlSec;
      else if (args.ttlSec !== undefined) step.ttlSec = args.ttlSec;
    }
    if (step.type === "respond" && args.status !== undefined) step.status = args.status;
  },
);

export const linkOutcome = defineCommand(
  z.object({
    operation: IdSchema,
    stepId: IdSchema,
    outcome: z.string().min(1),
    target: IdSchema.nullable(),
  }),
  (draft, args) => {
    const flow = requireFlow(draft, args.operation);
    const step = requireStep(flow, args.stepId);
    if (!isBranchingStep(step) || !stepOutcomes(step).includes(args.outcome)) {
      throw new CommandError(`Step ${args.stepId} has no outcome "${args.outcome}".`);
    }
    if (args.target === null) {
      delete step.next[args.outcome];
      return;
    }
    requireStep(flow, args.target);
    step.next[args.outcome] = args.target;
  },
);

export const setRoot = defineCommand(
  z.object({ operation: IdSchema, stepId: IdSchema.nullable() }),
  (draft, { operation, stepId }) => {
    const flow = requireFlow(draft, operation);
    if (stepId !== null) requireStep(flow, stepId);
    flow.root = stepId;
  },
);

/**
 * Removes a step. References to it are re-pointed to the step behind `bypass`
 * (when given) or unlinked. Steps that become unreachable are left in place and
 * reported by validation, so no work is lost silently.
 */
export const removeStep = defineCommand(
  z.object({ operation: IdSchema, stepId: IdSchema, bypass: z.string().min(1).optional() }),
  (draft, { operation, stepId, bypass }) => {
    const flow = requireFlow(draft, operation);
    const step = requireStep(flow, stepId);
    let replacement: string | undefined;
    if (bypass !== undefined) {
      if (!isBranchingStep(step) || !stepOutcomes(step).includes(bypass)) {
        throw new CommandError(`Step ${stepId} has no outcome "${bypass}".`);
      }
      replacement = step.next[bypass];
    }
    repointReferences(flow, stepId, replacement);
    delete flow.steps[stepId];
  },
);

/** Deletes the given steps and unlinks every reference to them. */
export function detachSteps(flow: Draft<Flow>, stepIds: readonly string[]): void {
  for (const stepId of stepIds) {
    repointReferences(flow, stepId, undefined);
    delete flow.steps[stepId];
  }
}

function repointReferences(flow: Draft<Flow>, from: string, to: string | undefined): void {
  if (flow.root === from) flow.root = to ?? null;
  for (const step of Object.values(flow.steps)) {
    if (step.type === "respond") continue;
    for (const [outcome, target] of Object.entries(step.next)) {
      if (target !== from) continue;
      if (to === undefined) delete step.next[outcome];
      else step.next[outcome] = to;
    }
  }
}

function toStep(input: StepInput): Step {
  switch (input.type) {
    case "call": {
      const { type, target, action, entity, ttlSec } = input;
      return {
        type,
        target,
        action,
        ...(entity === undefined ? {} : { entity }),
        ...(ttlSec === undefined ? {} : { ttlSec }),
        next: {},
      };
    }
    case "logic":
      return { type: "logic", logic: input.logic, next: {} };
    case "respond":
      return { type: "respond", status: input.status };
  }
}

function requireStep(flow: Draft<Flow>, stepId: string): Draft<Step> {
  const step = flow.steps[stepId];
  if (!step) throw new CommandError(`Step ${stepId} does not exist in "${flow.operation}".`);
  return step;
}

function currentAttachment(
  flow: Draft<Flow>,
  attach: z.output<typeof AttachSchema>,
): string | undefined {
  if (attach.to === "root") return flow.root ?? undefined;
  const parent = requireStep(flow, attach.stepId);
  if (!isBranchingStep(parent) || !stepOutcomes(parent).includes(attach.outcome)) {
    throw new CommandError(`Step ${attach.stepId} has no outcome "${attach.outcome}".`);
  }
  return parent.next[attach.outcome];
}

function setAttachment(flow: Draft<Flow>, attach: z.output<typeof AttachSchema>, id: string): void {
  if (attach.to === "root") {
    flow.root = id;
    return;
  }
  const parent = flow.steps[attach.stepId];
  if (parent && isBranchingStep(parent)) parent.next[attach.outcome] = id;
}
