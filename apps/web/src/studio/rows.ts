import type { OperationAnalysis, OperationMetrics } from "@archdrill/engine";
import type { Attempt, Flow } from "@archdrill/model";
import { type Sequence, type SequenceItem, sequenceOf } from "../panels/flow/sequence";
import type { CursorMode, CursorPosition } from "../state/ui-store";

/**
 * One row of the flow as a sequence diagram, top to bottom. Steps sit on the
 * handler's lifeline or call across to another; a branch opens a frame;
 * gaps are where a new step can go.
 */
export type StudioRow =
  | {
      readonly kind: "step";
      readonly key: string;
      readonly depth: number;
      readonly item: SequenceItem;
    }
  | {
      readonly kind: "frame";
      readonly key: string;
      readonly depth: number;
      readonly outcome: string;
      /** The step whose outcome the frame follows. */
      readonly stepId: string;
    }
  | {
      readonly kind: "respond";
      readonly key: string;
      readonly depth: number;
      readonly status: number;
      readonly stepId: string;
    }
  | {
      readonly kind: "goto";
      readonly key: string;
      readonly depth: number;
      readonly number: number;
      readonly stepId: string;
    }
  | {
      readonly kind: "gap";
      readonly key: string;
      readonly depth: number;
      readonly mode: CursorMode;
      /** Behind the last step of a list that leads nowhere yet: a response can go here too. */
      readonly end: boolean;
    };

/**
 * Rows of one list. `path` names the list (the branch it hangs from), so keys
 * stay unique even where two lists end the same way.
 */
function rowsOf(
  sequence: Sequence,
  entry: CursorPosition,
  depth: number,
  path: string,
  rows: StudioRow[],
) {
  let into = entry;
  for (const item of sequence.items) {
    rows.push({
      kind: "gap",
      key: `${path}|gap:before:${item.stepId}`,
      depth,
      mode: { kind: "insert", at: into, before: item.stepId },
      end: false,
    });
    rows.push({ kind: "step", key: `${path}|step:${item.stepId}`, depth, item });
    for (const exit of item.exits) {
      if (exit.kind !== "branch") continue;
      rows.push({
        kind: "frame",
        key: `${path}|frame:${item.stepId}:${exit.outcome}`,
        depth: depth + 1,
        outcome: exit.outcome,
        stepId: item.stepId,
      });
      rowsOf(
        exit.branch,
        { kind: "after", stepId: item.stepId, outcomes: [exit.outcome] },
        depth + 1,
        `${path}/${item.stepId}:${exit.outcome}`,
        rows,
      );
    }
    into = { kind: "after", stepId: item.stepId, outcomes: item.continuing };
  }
  const last = sequence.items.at(-1);
  const { end } = sequence;
  if (end.kind === "empty" || end.kind === "open") {
    const at: CursorPosition =
      end.kind === "open" && last
        ? { kind: "after", stepId: last.stepId, outcomes: end.outcomes }
        : into;
    rows.push({
      kind: "gap",
      key: `${path}|gap:end`,
      depth,
      mode: { kind: "append", at },
      end: true,
    });
  } else if (end.kind === "respond") {
    rows.push({
      kind: "gap",
      key: `${path}|gap:before:${end.target}`,
      depth,
      mode: { kind: "insert", at: into, before: end.target },
      end: false,
    });
    rows.push({
      kind: "respond",
      key: `${path}|respond:${end.target}`,
      depth,
      status: end.status,
      stepId: end.target,
    });
  } else {
    rows.push({
      kind: "goto",
      key: `${path}|goto:${end.target}`,
      depth,
      number: end.number,
      stepId: end.target,
    });
  }
}

/** The flow as diagram rows, numbered as on the canvas and in the Flow panel. */
export function studioRows(flow: Flow, attempt: Attempt): StudioRow[] {
  const rows: StudioRow[] = [];
  rowsOf(sequenceOf(flow, attempt), { kind: "root" }, 0, "root", rows);
  return rows;
}

/**
 * The lifelines right of the handler: what its steps call, in the order they
 * first call it, then any the person added to call next.
 */
export function studioColumns(rows: readonly StudioRow[], extra: readonly string[] = []): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    if (row.kind !== "step" || row.item.step.type !== "call") continue;
    if (!columns.includes(row.item.step.target)) columns.push(row.item.step.target);
  }
  for (const id of extra) if (!columns.includes(id)) columns.push(id);
  return columns;
}

/** Share of the operation's requests that reach each step, from the simulated paths. */
export function stepReach(
  analysis: OperationAnalysis | undefined,
  metrics: OperationMetrics | undefined,
): Map<string, number> {
  const reach = new Map<string, number>();
  if (!analysis || !metrics) return reach;
  const paths = new Map(analysis.paths.map((p) => [p.id, p]));
  for (const { pathId, probability } of metrics.paths) {
    const path = paths.get(pathId);
    if (!path || probability <= 0) continue;
    for (const stepId of new Set(path.steps.map((s) => s.stepId))) {
      reach.set(stepId, (reach.get(stepId) ?? 0) + probability);
    }
  }
  return reach;
}
