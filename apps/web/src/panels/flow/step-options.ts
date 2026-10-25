import {
  ACTIONS,
  type ActionId,
  type Attempt,
  actionTakesEntity,
  actionTakesParam,
  type CatalogIndex,
  callableFrom,
  connectionToCall,
  getLogic,
  type LogicId,
  offeredLogic,
  onlyServesObjects,
  type StepInput,
} from "@archdrill/model";
import { activePack } from "../../state/content";
import { successStatus } from "./defaults";
import type { EditContext } from "./flow-edits";
import type { PickerMode } from "./pick";
import { stepSentence } from "./sentences";

/** A step one choice adds, said as a sentence. */
export interface Option {
  readonly key: string;
  readonly label: string;
  readonly step: StepInput;
}

/** What the handler can call on one component, and whether it is connected to it yet. */
export interface TargetOptions {
  readonly connected: boolean;
  readonly options: Option[];
}

/**
 * Every call the handler can make, by the component it calls: connected to
 * it or not (choosing a step connects it).
 */
export function callOptions(
  attempt: Attempt,
  handler: string,
  entity: string,
  catalog: CatalogIndex,
): Map<string, TargetOptions> {
  const byTarget = new Map<string, TargetOptions>();
  for (const id of callableFrom(handler, attempt, catalog)) {
    const target = attempt.architecture.components.find((c) => c.id === id);
    if (!target) continue;
    const options: Option[] = [];
    for (const action of Object.keys(ACTIONS) as ActionId[]) {
      const def = ACTIONS[action];
      if (!catalog.capabilities(target.kind, target.flavor).has(def.capability)) continue;
      const events = actionTakesParam(action, "event")
        ? activePack.problem.events.map((e) => e.id)
        : [undefined];
      for (const event of events) {
        const step: StepInput = {
          type: "call",
          target: target.id,
          action,
          ...(actionTakesEntity(action) ? { entity } : {}),
          ...(event !== undefined ? { event } : {}),
          ...(action === "cache.set" ? { ttlSec: 3600 } : {}),
          ...(action === "cache.setNegative" ? { ttlSec: 60 } : {}),
        };
        options.push({
          key: `call:${target.id}:${action}:${event ?? ""}`,
          label: stepSentence(step, attempt),
          step,
        });
      }
    }
    const connected = connectionToCall(handler, target.id, attempt, catalog).kind !== "add";
    if (options.length > 0) byTarget.set(target.id, { connected, options });
  }
  return byTarget;
}

/**
 * The flow's handler only serves objects (object storage): it answers with
 * the object or stores it, so its flow is one response.
 */
export function servesOnly(ctx: Pick<EditContext, "attempt" | "flow" | "catalog">): boolean {
  const handler = ctx.attempt.architecture.components.find((c) => c.id === ctx.flow.handler);
  return (
    handler !== undefined &&
    onlyServesObjects(ctx.catalog.capabilities(handler.kind, handler.flavor))
  );
}

/** Statuses offered after the success ones, in the order people reach for them. */
const COMMON_STATUSES = [400, 404, 409, 429, 503] as const;

/** The problem's decisions, those a request of this operation can meet first. */
export function decisionOptions(ctx: EditContext, facts: ReadonlySet<string>): Option[] {
  if (servesOnly(ctx)) return [];
  const relevant = (id: LogicId) => {
    const fact = getLogic(id).decidedBy?.fact;
    return fact === undefined || facts.has(fact) ? 0 : 1;
  };
  return offeredLogic(ctx.problem.logic)
    .slice()
    .sort((a: LogicId, b: LogicId) => relevant(a) - relevant(b))
    .map((logic) => ({
      key: `logic:${logic}`,
      label: stepSentence({ type: "logic", logic }, ctx.attempt),
      step: { type: "logic", logic },
    }));
}

/**
 * The answers a request can end with there: none in front of a step or as
 * the first step, since a request does something before it answers; object
 * storage only answers, first.
 */
export function responseOptions(ctx: EditContext, mode: PickerMode): Option[] {
  if (mode.kind === "insert" || (mode.at.kind === "root" && !servesOnly(ctx))) return [];
  const { background, operation, problem, attempt } = ctx;
  const success = background ? [200] : [successStatus(operation, problem, attempt)];
  const statuses = background
    ? [200, 503]
    : [...new Set([...success, ...operation.successStatuses, ...COMMON_STATUSES])];
  return statuses.map((status) => ({
    key: `respond:${status}`,
    label: stepSentence({ type: "respond", status }, attempt, background),
    step: { type: "respond", status },
  }));
}
