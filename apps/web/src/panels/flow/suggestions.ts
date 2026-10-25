import {
  ACTIONS,
  type ActionId,
  type Attempt,
  actionTakesEntity,
  actionTakesParam,
  type CatalogIndex,
  type Flow,
  getLogic,
  type LogicId,
  type Operation,
  offeredLogic,
  outcomeTone,
  type Problem,
  type Step,
  type StepInput,
} from "@archdrill/model";
import type { Slot } from "../../state/ui-store";
import { servesOnly } from "./step-options";

/** A step one click adds to an open branch. */
export interface Suggestion {
  readonly key: string;
  readonly kind: "call" | "logic" | "respond";
  readonly step: StepInput;
}

/** At most this many suggestions per branch; the full form has the rest. */
const MAX_SUGGESTIONS = 6;
const MAX_CALLS = 2;
const MAX_LOGIC = 1;

/** Statuses an outcome usually ends with, most likely first. */
const STATUSES_BY_OUTCOME: Readonly<Record<string, readonly number[]>> = {
  error: [503],
  invalid: [400],
  notFound: [404],
  negativeHit: [404],
  expired: [410, 404],
  disabled: [410, 403],
  declined: [402],
  over: [429],
  conflict: [409],
  malicious: [400],
};

/** Steps from the root to `stepId`, following the first branch that reaches it. */
export function pathTo(flow: Flow, stepId: string): readonly Step[] {
  const seen = new Set<string>();
  const walk = (id: string, trail: readonly Step[]): readonly Step[] | null => {
    const step = flow.steps[id];
    if (!step || seen.has(id)) return null;
    seen.add(id);
    const here = [...trail, step];
    if (id === stepId) return here;
    if (step.type === "respond") return null;
    for (const next of Object.values(step.next)) {
      const found = walk(next, here);
      if (found) return found;
    }
    return null;
  };
  return flow.root === null ? [] : (walk(flow.root, []) ?? []);
}

/** The statuses a successful request ends with: the operation's 2xx and 3xx answers. */
function successStatuses(operation: Operation): number[] {
  const answers = operation.successStatuses.filter((s) => s < 400);
  return answers.length > 0 ? answers : [200];
}

/** Statuses worth offering after this outcome, most likely first. */
function respondStatuses(
  outcome: string | null,
  operation: Operation,
  background: boolean,
): number[] {
  if (outcome === null) return [];
  const tone = outcomeTone(outcome);
  // Background work only finishes or asks to be tried again.
  if (background) return tone === "error" ? [503] : tone === "positive" ? [200] : [200, 503];
  const known = STATUSES_BY_OUTCOME[outcome];
  if (known) return [...known];
  if (tone === "positive") return successStatuses(operation);
  return [];
}

/** The action a call to this component most likely makes at this point of the flow. */
function likelyAction(
  actions: readonly ActionId[],
  targetId: string,
  path: readonly Step[],
  operation: Operation,
): ActionId | undefined {
  const calledHere = (action: ActionId) =>
    path.some((s) => s.type === "call" && s.target === targetId && s.action === action);
  const prefer: ActionId[] = [];
  // A cache is read first, then filled after the store answered.
  if (actions.includes("cache.get")) {
    prefer.push(calledHere("cache.get") ? "cache.set" : "cache.get");
  }
  if (operation.class === "read") prefer.push("store.read");
  else prefer.push("store.insertIfAbsent", "store.insert", "store.update");
  prefer.push("queue.publish");
  return prefer.find((a) => actions.includes(a)) ?? actions[0];
}

/** The entity a new call most likely works on: the last one the path used, or the operation's. */
function likelyEntity(path: readonly Step[], defaultEntity: string): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const step = path[i];
    if (step?.type === "call" && step.entity !== undefined) return step.entity;
  }
  return defaultEntity;
}

export interface SuggestionInput {
  readonly attempt: Attempt;
  readonly flow: Flow;
  readonly slot: Slot;
  readonly problem: Problem;
  readonly operation: Operation;
  readonly catalog: CatalogIndex;
  readonly background: boolean;
  /** The entity the operation works on, when no earlier step names one. */
  readonly defaultEntity: string;
  /**
   * Facts the operation's requests can have (expired, invalid input…). A
   * decision decided by a fact no request has is never worth suggesting.
   */
  readonly facts?: ReadonlySet<string>;
}

/**
 * Steps that likely fill an open branch, most likely first: a response for
 * outcomes that usually end the request (errors, not found, invalid input),
 * otherwise calls to the components the handler can reach and the problem's
 * decisions, with the success response last.
 */
export function suggestNext(input: SuggestionInput): Suggestion[] {
  const { attempt, flow, slot, problem, operation, catalog, background } = input;
  // Object storage only answers: with the object, or that it stored it.
  if (servesOnly({ attempt, flow, catalog })) {
    return successStatuses(operation).map((status) => ({
      key: `respond:${status}`,
      kind: "respond",
      step: { type: "respond", status },
    }));
  }
  const outcome = slot.attach.to === "outcome" ? slot.attach.outcome : null;
  const path = slot.attach.to === "outcome" ? pathTo(flow, slot.attach.stepId) : [];
  const previous = path.at(-1);
  const entity = likelyEntity(path, input.defaultEntity);

  const responds: Suggestion[] = respondStatuses(outcome, operation, background).map((status) => ({
    key: `respond:${status}`,
    kind: "respond",
    step: { type: "respond", status },
  }));

  const calls: Suggestion[] = [];
  for (const connection of attempt.architecture.connections) {
    if (connection.from !== flow.handler) continue;
    const target = attempt.architecture.components.find((c) => c.id === connection.to);
    if (!target) continue;
    const caps = catalog.capabilities(target.kind, target.flavor);
    const actions = (Object.keys(ACTIONS) as ActionId[]).filter((id) =>
      caps.has(ACTIONS[id].capability),
    );
    const action = likelyAction(actions, target.id, path, operation);
    if (!action) continue;
    // Calling the same thing again straight after it answered is rarely the next step.
    if (previous?.type === "call" && previous.target === target.id && previous.action === action) {
      continue;
    }
    const event = problem.events[0]?.id;
    if (actionTakesParam(action, "event") && event === undefined) continue;
    calls.push({
      key: `call:${target.id}:${action}`,
      kind: "call",
      step: {
        type: "call",
        target: target.id,
        action,
        ...(actionTakesEntity(action) ? { entity } : {}),
        ...(actionTakesParam(action, "event") && event !== undefined ? { event } : {}),
        ...(action === "cache.set" ? { ttlSec: 3600 } : {}),
      },
    });
  }
  // Components not yet called on this path are the likelier next step.
  const used = new Set(path.flatMap((s) => (s.type === "call" ? [s.target] : [])));
  calls.sort(
    (a, b) =>
      Number(used.has((a.step as { target: string }).target)) -
      Number(used.has((b.step as { target: string }).target)),
  );

  const decided = new Set(path.flatMap((s) => (s.type === "logic" ? [s.logic] : [])));
  const relevant = (id: LogicId) => {
    const fact = getLogic(id).decidedBy?.fact;
    return fact === undefined || input.facts === undefined || input.facts.has(fact);
  };
  const logic: Suggestion[] = offeredLogic(problem.logic)
    .filter((id: LogicId) => !decided.has(id) && relevant(id))
    // Decisions about this operation's own requests first.
    .sort(
      (a, b) =>
        Number(getLogic(b).decidedBy !== undefined) - Number(getLogic(a).decidedBy !== undefined),
    )
    .slice(0, MAX_LOGIC)
    .map((id) => ({ key: `logic:${id}`, kind: "logic", step: { type: "logic", logic: id } }));

  // A decision that rests on another component (a local list) is confirmed by calling it.
  const decision = previous?.type === "logic" ? getLogic(previous.logic) : undefined;
  if (decision?.needs && outcome === decision.decidedBy?.outcome) {
    const capability = decision.needs.capability;
    const confirms = ({ step }: Suggestion) => {
      if (step.type !== "call") return false;
      const target = attempt.architecture.components.find((c) => c.id === step.target);
      return (
        target !== undefined && catalog.capabilities(target.kind, target.flavor).has(capability)
      );
    };
    return [...calls.filter(confirms), ...calls.filter((c) => !confirms(c)), ...responds].slice(
      0,
      MAX_SUGGESTIONS,
    );
  }

  // Outcomes that usually end the request lead with their response.
  const endsHere =
    outcome !== null &&
    (outcome in STATUSES_BY_OUTCOME ||
      ["error", "negative", "conflict"].includes(outcomeTone(outcome)));
  const ordered = endsHere
    ? [...responds, ...calls.slice(0, MAX_CALLS), ...logic]
    : [...calls.slice(0, MAX_CALLS), ...responds, ...logic];
  return ordered.slice(0, MAX_SUGGESTIONS);
}
