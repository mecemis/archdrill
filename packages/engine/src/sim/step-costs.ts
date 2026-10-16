import { ACTIONS, type Flavor, type Problem } from "@archdrill/model";
import type { CallPathStep, Path } from "../paths/types";
import type { SimulationContext } from "./setup";

/**
 * What one item of a call costs its target, beyond being one request: the
 * units it counts where the target meters by size, and the bytes a read
 * returns where the target's bandwidth is modelled.
 */
export interface StepCost {
  /** Units per item where the target counts them (`per: "item"`); 1 otherwise. */
  readonly units: number;
  /**
   * The target meters every item, so a batch costs each item's units in
   * capacity and price; otherwise a batch is one request.
   */
  readonly perItem: boolean;
  /** The target meters calls by payload: a batch's items share its units. */
  readonly perRequest: boolean;
  /** For payload meters: an item's bytes, and the bytes one unit covers. */
  readonly payload: { readonly itemBytes: number; readonly unitBytes: number } | null;
  /** Bytes one item returns over the network; 0 where bandwidth is not modelled. */
  readonly bytes: number;
  /**
   * Bytes of the item the call carries, either way: the value a read
   * returns, or what a write or a message sends. Keys and headers are left
   * out; 0 for calls that carry no item (deletes, counters, id blocks).
   */
  readonly carriedBytes: number;
}

export const PLAIN_COST: StepCost = {
  units: 1,
  perItem: false,
  perRequest: false,
  payload: null,
  bytes: 0,
  carriedBytes: 0,
};

/** Units one call takes on a payload meter, for the items it carries. */
export function requestUnitsFor(cost: StepCost, itemsPerCall: number): number {
  if (!cost.payload) return 1;
  return unitsOf(itemsPerCall * cost.payload.itemBytes, cost.payload.unitBytes);
}

/** Reads whose outcome returns the item's value. */
const RETURNS_VALUE: Readonly<Record<string, string>> = {
  "cache.get": "hit",
  "store.read": "found",
};

/** Calls that send the item itself, or ask another service about it. */
const SENDS_ITEM: ReadonlySet<string> = new Set([
  "cache.set",
  "store.insert",
  "store.update",
  "queue.publish",
  "connection.push",
  "service.call",
]);

const unitsOf = (bytes: number, unitBytes: number) => Math.max(1, Math.ceil(bytes / unitBytes));

/** Bytes of one message about an event: its own size, or its entity's. */
export function messageBytes(problem: Problem, eventId: string | undefined): number {
  const event = problem.events.find((e) => e.id === eventId);
  if (!event) return 0;
  return event.bytes ?? problem.entities.find((e) => e.name === event.entity)?.avgBytes ?? 0;
}

function itemBytes(step: CallPathStep, ctx: SimulationContext): number {
  if (step.action === "queue.publish") return messageBytes(ctx.problem, step.event);
  return ctx.problem.entities.find((e) => e.name === step.entity)?.avgBytes ?? 0;
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
  const bytes = itemBytes(step, ctx);
  const carriedBytes = returnsValue || SENDS_ITEM.has(step.action) ? bytes : 0;
  if (!meter && !(returnsValue && bandwidth)) {
    return carriedBytes === 0 ? PLAIN_COST : { ...PLAIN_COST, carriedBytes };
  }
  const perRequest = meter?.per === "request";
  return {
    units: meter && !perRequest ? unitsFor(meter, step, bytes) : 1,
    perItem: meter?.per === "item",
    perRequest,
    payload:
      meter && perRequest
        ? {
            itemBytes: bytes,
            unitBytes: ACTIONS[step.action].effect === "read" ? meter.readBytes : meter.writeBytes,
          }
        : null,
    bytes: returnsValue && bandwidth ? bytes : 0,
    carriedBytes,
  };
}

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
