import type { Attempt, Flow, StepInput } from "@archdrill/model";
import { activePack, catalogIndex } from "../../state/content";
import { useAttemptStore } from "../../state/store";
import { operationById, runsInBackground } from "../../state/triggers";
import { type CursorMode, type Slot, useUi } from "../../state/ui-store";
import { openSlots } from "./add-step";
import type { EditContext } from "./flow-edits";
import { commitStep } from "./pick";
import { outcomeLabel } from "./sentences";
import { sequenceOf } from "./sequence";
import { stepTitle } from "./step-label";

/** The edit context of an operation's flow, outside the Flow panel; null without a flow. */
export function editContextFor(attempt: Attempt, operationId: string): EditContext | null {
  const flow = attempt.flows.find((f) => f.operation === operationId);
  const operation = operationById(operationId);
  if (!flow || !operation) return null;
  return {
    flow,
    attempt,
    problem: activePack.problem,
    operation,
    catalog: catalogIndex,
    background: runsInBackground(operation),
  };
}

/**
 * Places a new step can go, most useful first: branches that lead nowhere
 * yet, then in front of the main path's response.
 */
export function cursorPositions(flow: Flow, attempt: Attempt): CursorMode[] {
  if (flow.root === null) return [{ kind: "append", at: { kind: "root" } }];
  const modes: CursorMode[] = openSlots(flow, attempt).map((slot) =>
    slot.to === "root"
      ? { kind: "append", at: { kind: "root" } }
      : {
          kind: "append",
          at: { kind: "after", stepId: slot.stepId, outcomes: [slot.outcome] },
        },
  );
  const main = sequenceOf(flow, attempt);
  const last = main.items.at(-1);
  if (last && main.end.kind === "respond") {
    modes.push({
      kind: "insert",
      at: { kind: "after", stepId: last.stepId, outcomes: last.continuing },
      before: main.end.target,
    });
  }
  return modes;
}

/** The slot for a position, with the parts suggestions and the canvas read. */
export function slotFor(operation: string, mode: CursorMode, source: "panel" | "canvas"): Slot {
  return {
    operation,
    attach:
      mode.at.kind === "root"
        ? { to: "root" }
        : { to: "outcome", stepId: mode.at.stepId, outcome: mode.at.outcomes[0] ?? "" },
    ...(mode.kind === "insert" ? { before: mode.before } : {}),
    mode,
    source,
  };
}

/** The position a slot stands for. */
export function modeOf(slot: Slot): CursorMode {
  if (slot.mode) return slot.mode;
  const at =
    slot.attach.to === "root"
      ? ({ kind: "root" } as const)
      : ({
          kind: "after",
          stepId: slot.attach.stepId,
          outcomes: [slot.attach.outcome],
        } as const);
  return slot.before ? { kind: "insert", at, before: slot.before } : { kind: "append", at };
}

/** Whether two positions are the same place. */
export function sameMode(a: CursorMode, b: CursorMode): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Where a position is, in words: "as the first step", "after 2 · Check
 * status, if active", "before responding, after 3 · Links DB · read Link".
 */
export function describeCursor(
  mode: CursorMode,
  flow: Flow,
  attempt: Attempt,
  background: boolean,
): string {
  if (mode.at.kind === "root") {
    return mode.kind === "insert" ? "before the first step" : "as the first step";
  }
  const sequence = sequenceOf(flow, attempt);
  const number = numberOf(sequence, mode.at.stepId);
  const step = flow.steps[mode.at.stepId];
  const name = step ? stepTitle(step, attempt, background, false) : mode.at.stepId;
  const after = `after ${number === null ? "" : `${number} · `}${name}`;
  const outcomes = mode.at.outcomes.map(outcomeLabel).join(" or ");
  const when = step?.type === "respond" || outcomes === "" ? "" : `, if ${outcomes}`;
  const beforeResponse = mode.kind === "insert" && flow.steps[mode.before]?.type === "respond";
  return beforeResponse ? `before responding, ${after}${when}` : `${after}${when}`;
}

/** A step's number as the Flow panel shows it, searching branches too. */
function numberOf(sequence: ReturnType<typeof sequenceOf>, stepId: string): number | null {
  for (const item of sequence.items) {
    if (item.stepId === stepId) return item.number;
    for (const exit of item.exits) {
      if (exit.kind !== "branch") continue;
      const found = numberOf(exit.branch, stepId);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Where to carry on after adding a step: behind the step just added, else
 * the flow's first open place.
 */
export function nextCursor(before: Flow, after: Flow, attempt: Attempt): CursorMode | null {
  const added = new Set(Object.keys(after.steps).filter((id) => !(id in before.steps)));
  const positions = cursorPositions(after, attempt);
  return (
    positions.find((m) => m.at.kind === "after" && added.has(m.at.stepId)) ?? positions[0] ?? null
  );
}

/**
 * Adds a step chosen on the canvas at the armed slot, then moves the slot
 * behind it so the next click carries on from there. Returns whether it was added.
 */
export function addAtSlot(slot: Slot, step: StepInput): boolean {
  const attempt = useAttemptStore.getState().attempt;
  const ctx = editContextFor(attempt, slot.operation);
  if (!ctx || !commitStep(ctx, modeOf(slot), step)) return false;
  const now = useAttemptStore.getState().attempt;
  const flow = now.flows.find((f) => f.operation === slot.operation);
  const next = flow ? nextCursor(ctx.flow, flow, now) : null;
  useUi.getState().armSlot(next ? slotFor(slot.operation, next, "canvas") : null);
  return true;
}
