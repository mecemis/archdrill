import { ACTIONS, type Flavor } from "@archdrill/model";
import type { CallPathStep, Path } from "../paths/types";
import type { SimulationContext } from "./setup";

/**
 * What one item of a call costs its target, beyond being one request: the
 * units it counts where the target meters by size, and the bytes a read
 * returns where the target's bandwidth is modelled.
 */
export interface StepCost {
  /**
   * Units per item (`per: "item"`), or per call (`per: "request"`), where the
   * target counts them; 1 where it counts requests.
   */
  readonly units: number;
  /**
   * The target meters every item, so a batch costs each item's units in
   * capacity and price; otherwise a batch is one request.
   */
  readonly perItem: boolean;
  /** The target meters calls by payload: a batch's items share its units. */
  readonly perRequest: boolean;
  /** Bytes one item returns over the network; 0 where bandwidth is not modelled. */
  readonly bytes: number;
}

export const PLAIN_COST: StepCost = { units: 1, perItem: false, perRequest: false, bytes: 0 };

/** Reads whose outcome returns the item's value. */
const RETURNS_VALUE: Readonly<Record<string, string>> = {
  "cache.get": "hit",
  "store.read": "found",
};

const unitsOf = (bytes: number, unitBytes: number) => Math.max(1, Math.ceil(bytes / unitBytes));

function itemBytes(step: CallPathStep, ctx: SimulationContext): number {
  const entity =
    step.action === "queue.publish"
      ? ctx.problem.events.find((e) => e.id === step.event)?.entity
      : step.entity;
  return ctx.problem.entities.find((e) => e.name === entity)?.avgBytes ?? 0;
}

/** Units one item, or one request, takes on a flavor that counts them. */
function unitsFor(
  meter: NonNullable<Flavor["requestUnits"]>,
  step: CallPathStep,
  bytes: number,
): number {
  if (ACTIONS[step.action].effect !== "read") return unitsOf(bytes, meter.writeBytes);
  // A read of an item that does not exist still takes the smallest read.
  const returned = RETURNS_VALUE[step.action] === step.outcome ? bytes : 0;
  return meter.readUnits * unitsOf(returned, meter.readBytes);
}

function callCost(step: CallPathStep, ctx: SimulationContext): StepCost {
  const component = ctx.attempt.architecture.components.find((c) => c.id === step.target);
  if (!component) return PLAIN_COST;
  const flavor = ctx.catalog.flavor(component.kind, component.flavor);
  const size = flavor?.sizes[component.size ?? flavor.defaultSize ?? ""];
  const meter = flavor?.requestUnits;
  const returnsValue = RETURNS_VALUE[step.action] === step.outcome;
  const bandwidth = size?.networkGbps !== undefined;
  if (!meter && !(returnsValue && bandwidth)) return PLAIN_COST;
  const bytes = itemBytes(step, ctx);
  return {
    units: meter ? unitsFor(meter, step, bytes * (meter.per === "request" ? batchOf(step) : 1)) : 1,
    perItem: meter?.per === "item",
    perRequest: meter?.per === "request",
    bytes: returnsValue && bandwidth ? bytes : 0,
  };
}

/** Items one call of a step carries: a batch's size, else one. */
const batchOf = (step: CallPathStep) => Math.max(1, step.batchSize ?? 1);

/**
 * Every path's step costs, aligned with its steps. Paths share the step
 * objects of a common prefix, so each step is costed once.
 */
export function stepCosts(
  paths: readonly Path[],
  ctx: SimulationContext,
): readonly (readonly StepCost[])[] {
  const known = new Map<CallPathStep, StepCost>();
  return paths.map((path) =>
    path.steps.map((step) => {
      if (step.kind !== "call") return PLAIN_COST;
      const cached = known.get(step);
      if (cached) return cached;
      const cost = callCost(step, ctx);
      known.set(step, cost);
      return cost;
    }),
  );
}
