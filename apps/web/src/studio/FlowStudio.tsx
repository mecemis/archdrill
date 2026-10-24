import { ACTIONS, callableFrom, findOperationRoute, LOGIC, type Operation } from "@archdrill/model";
import { ArrowLeft, Plus, Workflow, X } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { openSlots } from "../panels/flow/add-step";
import { editContextFor } from "../panels/flow/cursor";
import { FlowPanel } from "../panels/flow/FlowPanel";
import { operationFacts } from "../panels/flow/FlowSequence";
import type { EditContext } from "../panels/flow/flow-edits";
import { patternsAt } from "../panels/flow/patterns";
import { commitPattern, commitStep, operationEntity } from "../panels/flow/pick";
import { outcomeLabel } from "../panels/flow/sentences";
import type { SequenceItem } from "../panels/flow/sequence";
import { componentLabel } from "../panels/flow/step-label";
import {
  callOptions,
  decisionOptions,
  type Option,
  responseOptions,
} from "../panels/flow/step-options";
import { activePack, catalogIndex } from "../state/content";
import { useEvaluation, useScenarioLoad } from "../state/evaluation";
import { useAttemptStore } from "../state/store";
import { eventLabel, respondLabel, triggerSummary } from "../state/triggers";
import { type CursorMode, useUi } from "../state/ui-store";
import { factorLabel } from "../state/what-if-compute";
import { percent } from "../ui/format";
import { KindChip } from "../ui/icons";
import { FOCUS_RING, IconButton } from "../ui/primitives";
import { type StudioRow, stepReach, studioColumns, studioRows } from "./rows";

/** Width of one lifeline's column, in pixels. */
const COLUMN = 168;
/** Indent of each nested frame. */
const FRAME_INDENT = 12;
/** Width of a place's menu, in pixels. */
const MENU_WIDTH = 288;
/** Height of a message's label and line, above whatever follows in its row. */
const MESSAGE_HEIGHT = 38;

const x = (column: number) => column * COLUMN + COLUMN / 2;

/** A menu opens right of the "+" clicked, or left of it near the right edge. */
function menuLeft(anchor: number, width: number): number {
  return anchor + 16 + MENU_WIDTH > width ? Math.max(8, anchor - MENU_WIDTH - 8) : anchor + 16;
}

/** Where a menu for a place in the flow opens, and what it offers. */
interface MenuAt {
  /** The operation whose flow it adds to; switching operation leaves it behind. */
  readonly operation: string;
  readonly mode: CursorMode;
  /** The lifeline clicked: 0 the source, 1 the handler, 2+ what it calls; null offers everything. */
  readonly column: number | null;
  readonly left: number;
  readonly top: number;
}

/** The flow studio: the operation's flow as a sequence diagram, over the whole app. */
export function FlowStudio() {
  const open = useUi((s) => s.studioOpen);
  return open ? <StudioLayer /> : null;
}

/** Text fields keep their own Escape. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)
  );
}

function StudioLayer() {
  const operationId = useUi((s) => s.operation);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const operation = activePack.problem.operations.find((o) => o.id === operationId);
  // The shares of requests on the steps follow the traffic shown, a what-if too.
  const { whatIf } = useScenarioLoad();

  // Escape closes an open menu first, then the studio. The Flow panel beside the
  // diagram keeps its own Escape for its pickers and popovers.
  const menuOpen = menu !== null;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isTyping(event.target)) return;
      if (event.target instanceof Element && event.target.closest("[data-studio-panel]")) return;
      event.stopImmediatePropagation();
      if (menuOpen) setMenu(null);
      else useUi.getState().setStudioOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [menuOpen]);

  // Focus moves in on opening, and back to whatever opened it on closing.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    heading.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Flow studio"
      className="fixed inset-0 z-40 flex flex-col bg-app text-fg"
      data-testid="flow-studio"
    >
      <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2">
        <Workflow className="h-4 w-4 text-accent-fg" aria-hidden="true" />
        <h2 ref={heading} tabIndex={-1} className="text-sm font-semibold outline-none">
          Flow studio
        </h2>
        {operation && (
          <span className="truncate text-sm text-fg-muted">
            {triggerSummary(operation)} · {operation.label}
          </span>
        )}
        {whatIf && (
          <span
            className="rounded-md border border-warn-line bg-warn-soft px-1.5 py-0.5 text-xs text-warn-fg"
            data-testid="studio-what-if"
          >
            Traffic {factorLabel(whatIf.factor)}: a what-if, not scored
          </span>
        )}
        <button
          type="button"
          onClick={() => useUi.getState().setStudioOpen(false)}
          className={`ml-auto flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-fg-muted hover:text-fg ${FOCUS_RING}`}
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back to the canvas
        </button>
      </header>
      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: "13rem minmax(0,1fr) 24rem" }}
      >
        <OperationList />
        <div className="min-h-0 overflow-auto" data-testid="studio-diagram">
          <Diagram menu={menu?.operation === operationId ? menu : null} setMenu={setMenu} />
        </div>
        <aside
          aria-label="Steps"
          className="min-h-0 overflow-y-auto border-l border-line bg-surface"
          data-studio-panel
        >
          <FlowPanel />
        </aside>
      </div>
    </div>
  );
}

/** The problem's operations, with how far each flow has come. */
function OperationList() {
  const attempt = useAttemptStore((s) => s.attempt);
  const current = useUi((s) => s.operation);
  const scenarioId = useUi((s) => s.scenarioId);
  const scenario = activePack.scenarios.find((s) => s.id === scenarioId);
  return (
    <nav
      aria-label="Operations"
      className="flex min-h-0 flex-col gap-1 overflow-y-auto border-r border-line bg-surface p-2"
    >
      {activePack.problem.operations.map((op) => {
        const flow = attempt.flows.find((f) => f.operation === op.id);
        const open = flow ? openSlots(flow, attempt).length : 0;
        const status = !flow
          ? "no flow yet"
          : flow.root === null
            ? "empty"
            : open > 0
              ? `${open} open branch${open === 1 ? "" : "es"}`
              : "complete";
        const selected = op.id === current;
        return (
          <button
            key={op.id}
            type="button"
            aria-current={selected || undefined}
            onClick={() => useUi.getState().setOperation(op.id)}
            className={`flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left ${FOCUS_RING} ${
              selected ? "bg-accent-soft text-accent-fg" : "text-fg hover:bg-muted"
            }`}
          >
            <span className="text-[13px] font-medium">{op.label}</span>
            <span className="text-[11px] text-fg-subtle">{triggerSummary(op)}</span>
            <span
              className={`text-[11px] ${status === "complete" ? "text-ok-fg" : flow ? "text-warn-fg" : "text-fg-subtle"}`}
            >
              {status}
              {scenario?.focusOperations.includes(op.id) ? " · in focus" : ""}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/** What the first lifeline stands for: the client, the queue a consumer reads, or the schedule. */
function sourceLabel(operation: Operation, ctx: EditContext): string {
  if (operation.trigger.type === "schedule") return "Schedule";
  const route = findOperationRoute(operation, ctx.attempt, catalogIndex, ctx.flow.handler);
  const first = route?.components[0];
  if (first) return componentLabel(ctx.attempt, first);
  return operation.trigger.type === "event" ? eventLabel(operation.trigger.event) : "Client";
}

interface RowView {
  readonly ctx: EditContext;
  readonly columns: readonly string[];
  readonly reach: ReadonlyMap<string, number>;
  readonly selected: string | null;
  readonly openMenu: (
    event: MouseEvent<HTMLElement>,
    mode: CursorMode,
    column: number | null,
  ) => void;
}

function Diagram({
  menu,
  setMenu,
}: {
  readonly menu: MenuAt | null;
  readonly setMenu: (menu: MenuAt | null) => void;
}) {
  const attempt = useAttemptStore((s) => s.attempt);
  const operationId = useUi((s) => s.operation);
  const focused = useUi((s) => s.focusedStep);
  const added = useUi((s) => s.studioLifelines[operationId]);
  const { analysis } = useEvaluation();
  const { metrics } = useScenarioLoad();
  const body = useRef<HTMLDivElement>(null);
  const ctx = editContextFor(attempt, operationId);
  const flow = ctx?.flow;
  const rows = useMemo(() => (flow ? studioRows(flow, attempt) : []), [flow, attempt]);
  const reach = useMemo(
    () => stepReach(analysis.operations.get(operationId), metrics?.operations.get(operationId)),
    [analysis, metrics, operationId],
  );
  if (!ctx) {
    return (
      <p className="m-6 max-w-md rounded-xl border border-info-line bg-info-soft px-4 py-3 text-sm text-info-fg">
        No flow yet. Choose the service that handles this operation in the panel on the right, and
        its lifelines appear here.
      </p>
    );
  }
  // Lifelines added to call next, as long as their component is still there.
  const extra = (added ?? []).filter((id) =>
    attempt.architecture.components.some((c) => c.id === id),
  );
  const columns = ["", ctx.flow.handler, ...studioColumns(rows, extra)];
  const width = columns.length * COLUMN + COLUMN;
  const others = callableFrom(ctx.flow.handler, attempt, catalogIndex).filter(
    (id) => !columns.includes(id),
  );
  const openMenu = (event: MouseEvent<HTMLElement>, mode: CursorMode, column: number | null) => {
    const box = body.current?.getBoundingClientRect();
    const at = event.currentTarget.getBoundingClientRect();
    setMenu({
      operation: operationId,
      mode,
      column,
      left: menuLeft(at.left - (box?.left ?? 0), width),
      top: at.bottom - (box?.top ?? 0) + 4,
    });
  };
  const view: RowView = {
    ctx,
    columns,
    reach,
    selected: focused?.operation === operationId ? focused.stepId : null,
    openMenu,
  };
  return (
    <div className="relative px-4 pb-80" style={{ width: width + 32 }}>
      <Lifelines
        columns={columns}
        source={sourceLabel(ctx.operation, ctx)}
        ctx={ctx}
        others={others}
        onAdd={(id) => useUi.getState().addStudioLifeline(operationId, id)}
      />
      <div ref={body} className="relative" style={{ width }}>
        {columns.map((id, i) => (
          <div
            key={id || "source"}
            aria-hidden="true"
            className="absolute top-0 bottom-0 border-l border-dashed border-line-strong"
            style={{ left: x(i) }}
          />
        ))}
        <ol className="relative flex flex-col" aria-label="Steps of the flow">
          {rows.map((row) => (
            <li key={row.key} className="relative">
              <Row row={row} view={view} />
            </li>
          ))}
        </ol>
        {menu && (
          <PlaceMenu
            key={`${menu.left}:${menu.top}:${menu.column}`}
            menu={menu}
            ctx={ctx}
            columns={columns}
            onClose={() => setMenu(null)}
          />
        )}
      </div>
    </div>
  );
}

/** The lifelines' heads: the source, the handler, what it calls, and a way to call something else. */
function Lifelines({
  columns,
  source,
  ctx,
  others,
  onAdd,
}: {
  readonly columns: readonly string[];
  readonly source: string;
  readonly ctx: EditContext;
  readonly others: readonly string[];
  readonly onAdd: (id: string) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  // While the list is open, Escape closes it rather than the studio.
  useEffect(() => {
    if (!choosing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      setChoosing(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [choosing]);
  return (
    <div className="sticky top-0 z-10 flex bg-app py-3">
      {columns.map((id, i) => {
        const component = ctx.attempt.architecture.components.find((c) => c.id === id);
        return (
          <div key={id || "source"} className="flex justify-center px-2" style={{ width: COLUMN }}>
            <div
              className={`flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] font-medium shadow-card ${
                i === 1
                  ? "border-accent-line bg-accent-soft text-accent-fg"
                  : "border-line bg-elevated"
              }`}
              data-testid={`lifeline-${id || "source"}`}
            >
              {component && <KindChip kind={component.kind} size="xs" />}
              <span className="truncate">{i === 0 ? source : componentLabel(ctx.attempt, id)}</span>
            </div>
          </div>
        );
      })}
      {others.length > 0 && (
        <div className="relative flex justify-center px-2" style={{ width: COLUMN }}>
          <button
            type="button"
            aria-expanded={choosing}
            onClick={() => setChoosing((on) => !on)}
            className={`flex items-center gap-1 rounded-lg border border-dashed border-line-strong px-2.5 py-1.5 text-[13px] text-fg-muted hover:text-fg ${FOCUS_RING}`}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Call another
          </button>
          {choosing && (
            <div className="absolute top-full z-20 mt-1 flex w-56 flex-col rounded-xl border border-line bg-elevated p-1.5 shadow-pop">
              {others.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    onAdd(id);
                    setChoosing(false);
                  }}
                  className={`rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-accent-soft ${FOCUS_RING}`}
                >
                  {componentLabel(ctx.attempt, id)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The frames a row sits in, as bands from the handler's lifeline rightwards. */
function Frames({ depth }: { readonly depth: number }) {
  return Array.from({ length: depth }, (_, level) => (
    <div
      // biome-ignore lint/suspicious/noArrayIndexKey: one band per nesting level, never reordered
      key={level}
      aria-hidden="true"
      className="absolute top-0 right-0 bottom-0 border-l-2 border-accent-line bg-accent-soft/25"
      style={{ left: x(1) - COLUMN / 2 + 4 + level * FRAME_INDENT }}
    />
  ));
}

function Row({ row, view }: { readonly row: StudioRow; readonly view: RowView }) {
  switch (row.kind) {
    case "gap":
      return <GapRow row={row} view={view} />;
    case "frame":
      return (
        <div className="relative h-7">
          <Frames depth={row.depth} />
          <span
            className="absolute top-1.5 rounded-md bg-accent px-1.5 text-[11px] font-semibold text-on-accent"
            style={{ left: x(1) - COLUMN / 2 + 10 + (row.depth - 1) * FRAME_INDENT }}
          >
            if {outcomeLabel(row.outcome)}
          </span>
        </div>
      );
    case "respond":
      return (
        <div className="relative" style={{ height: MESSAGE_HEIGHT + 6 }}>
          <Frames depth={row.depth} />
          <Arrow
            from={1}
            to={0}
            tone="ok"
            label={
              <span
                className="rounded-md bg-ok-soft px-1.5 py-0.5 text-[13px] font-medium text-ok-fg"
                data-testid="studio-response"
              >
                {respondLabel(row.status, view.ctx.background)}
              </span>
            }
          />
        </div>
      );
    case "goto":
      return (
        <div className="relative h-8">
          <Frames depth={row.depth} />
          <span className="absolute top-1.5 text-xs text-fg-muted" style={{ left: x(1) + 10 }}>
            ↪ carry on at step {row.number}
          </span>
        </div>
      );
    case "step":
      return <StepRow item={row.item} depth={row.depth} view={view} />;
  }
}

/** A message between two lifelines, left to right or back, with its label above it. */
function Arrow({
  from,
  to,
  label,
  tone = "accent",
}: {
  readonly from: number;
  readonly to: number;
  readonly label: ReactNode;
  readonly tone?: "accent" | "ok";
}) {
  const left = Math.min(x(from), x(to));
  const width = Math.abs(x(to) - x(from));
  const backwards = to < from;
  return (
    <div className="absolute top-0" style={{ left, width, height: MESSAGE_HEIGHT }}>
      <div className="flex min-w-0 justify-center px-2 pt-1">{label}</div>
      <div className={`relative h-0.5 ${tone === "ok" ? "bg-ok" : "bg-accent"}`}>
        <span
          aria-hidden="true"
          className={`absolute top-1/2 h-0 w-0 -translate-y-1/2 border-y-[5px] border-y-transparent ${
            backwards
              ? "left-0 border-r-[8px] border-r-[var(--ok)]"
              : "right-0 border-l-[8px] border-l-[var(--accent)]"
          }`}
        />
      </div>
    </div>
  );
}

function StepRow({
  item,
  depth,
  view,
}: {
  readonly item: SequenceItem;
  readonly depth: number;
  readonly view: RowView;
}) {
  const { ctx, columns, reach, selected } = view;
  const { step } = item;
  const share = reach.get(item.stepId);
  const isSelected = selected === item.stepId;
  const select = () => useUi.getState().focusStep(ctx.flow.operation, item.stepId);
  // A step chosen here or just added comes into view.
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (isSelected) button.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isSelected]);
  const title =
    step.type === "call"
      ? `${ACTIONS[step.action].label} ${step.event === undefined ? (step.entity ?? "") : eventLabel(step.event)}`.trim()
      : LOGIC[step.logic].label;
  const label = (
    <button
      ref={button}
      type="button"
      onClick={select}
      aria-pressed={isSelected}
      className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] ${FOCUS_RING} ${
        isSelected ? "bg-accent text-on-accent" : "bg-elevated text-fg hover:bg-accent-soft"
      }`}
      data-testid={`studio-step-${item.stepId}`}
    >
      <span
        className={`flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold ${
          isSelected ? "bg-on-accent text-accent-fg" : "bg-accent text-on-accent"
        }`}
      >
        {item.number}
      </span>
      <span className="truncate">{title}</span>
    </button>
  );
  const reached =
    share === undefined ? null : (
      <span
        className="shrink-0 text-[11px] text-fg-subtle tabular-nums"
        title="Share of this operation's requests that reach the step"
        data-testid="studio-reach"
      >
        {percent(share, share < 0.01 ? 2 : 0)}
      </span>
    );
  // Every call goes to a lifeline of its own; a missing one would be a bug, shown as a note.
  const to = step.type === "call" ? columns.indexOf(step.target) : -1;
  return (
    <div className="relative min-h-16 pb-2">
      <Frames depth={depth} />
      {to >= 2 ? (
        <>
          <Arrow
            from={1}
            to={to}
            label={
              <span className="flex min-w-0 max-w-full items-center gap-1.5">
                {label}
                {reached}
              </span>
            }
          />
          {/*
            In the flow of the row, so the row grows with them. Not positioned, so
            the message above, which is, stays on top and takes its clicks.
          */}
          <div
            style={{
              marginLeft: x(1) + 4,
              paddingTop: MESSAGE_HEIGHT,
              maxWidth: Math.max(COLUMN * 2, x(to) - x(1)),
            }}
          >
            <Exits item={item} view={view} />
          </div>
        </>
      ) : (
        <div
          className="relative flex flex-col items-start gap-1 pt-1"
          style={{ marginLeft: x(1) - 6, maxWidth: COLUMN * 2 }}
        >
          <div className="flex items-center gap-1.5">
            <div className="rounded-lg border border-line bg-surface p-0.5 shadow-card">
              {label}
            </div>
            {reached}
          </div>
          <Exits item={item} view={view} />
        </div>
      )}
    </div>
  );
}

/** Where a step's other outcomes go: a response, another step, below, or nowhere yet. */
function Exits({ item, view }: { readonly item: SequenceItem; readonly view: RowView }) {
  if (item.exits.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 px-1">
      {item.exits.map((exit) => {
        const when = outcomeLabel(exit.outcome);
        if (exit.kind === "open") {
          return (
            <button
              key={exit.outcome}
              type="button"
              onClick={(event) =>
                view.openMenu(
                  event,
                  {
                    kind: "append",
                    at: { kind: "after", stepId: item.stepId, outcomes: [exit.outcome] },
                  },
                  null,
                )
              }
              className={`rounded-md border border-dashed border-warn-line bg-warn-soft px-1.5 text-[11px] text-warn-fg ${FOCUS_RING}`}
            >
              + if {when}
            </button>
          );
        }
        const where =
          exit.kind === "respond"
            ? String(exit.status)
            : exit.kind === "goto"
              ? `step ${exit.number}`
              : "below";
        return (
          <span key={exit.outcome} className="rounded-md bg-muted px-1.5 text-[11px] text-fg-muted">
            {when} → {where}
          </span>
        );
      })}
    </div>
  );
}

/**
 * A place a step can go: a "+" on every lifeline that has something to offer
 * there. Only the handler's takes keyboard focus, and from the keyboard it
 * offers everything, so a gap is one tab stop.
 */
function GapRow({
  row,
  view,
}: {
  readonly row: Extract<StudioRow, { kind: "gap" }>;
  readonly view: RowView;
}) {
  const { columns, ctx } = view;
  return (
    <div className={`group relative ${row.end ? "h-9" : "h-5"}`}>
      <Frames depth={row.depth} />
      {columns.map((id, i) => {
        // The source lifeline takes answers, which only end a list that leads nowhere yet.
        if (i === 0 && !(row.end && row.mode.kind === "append" && row.mode.at.kind !== "root")) {
          return null;
        }
        const name =
          i === 0
            ? "a response"
            : i === 1
              ? "a decision"
              : `a step with ${componentLabel(ctx.attempt, id)}`;
        return (
          <button
            key={id || "source"}
            type="button"
            tabIndex={i === 1 ? 0 : -1}
            aria-label={`Add ${name} here`}
            title={`Add ${name} here`}
            // A keyboard press (no click count) on the handler's "+" offers every lifeline.
            onClick={(event) =>
              view.openMenu(event, row.mode, i === 1 && event.detail === 0 ? null : i)
            }
            className={`absolute top-1/2 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-accent-line bg-elevated text-accent-fg shadow-card transition-opacity hover:bg-accent hover:text-on-accent focus-visible:opacity-100 ${FOCUS_RING} ${
              row.end ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
            style={{ left: x(i) }}
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * What can go at a place, for the lifeline clicked, or everything when none
 * was: then the usual patterns that fit come first.
 */
function PlaceMenu({
  menu,
  ctx,
  columns,
  onClose,
}: {
  readonly menu: MenuAt;
  readonly ctx: EditContext;
  readonly columns: readonly string[];
  readonly onClose: () => void;
}) {
  const facts = useMemo(() => operationFacts(ctx.flow.operation), [ctx.flow.operation]);
  const entity = operationEntity(ctx.flow.operation);
  const calls = useMemo(
    () => callOptions(ctx.attempt, ctx.flow.handler, entity, catalogIndex),
    [ctx.attempt, ctx.flow.handler, entity],
  );
  const groups: { title: string; options: Option[] }[] = [];
  const add = (column: number) => {
    if (column === 0) {
      groups.push({ title: "Respond", options: responseOptions(ctx, menu.mode) });
    } else if (column === 1) {
      groups.push({ title: "Decide", options: decisionOptions(ctx, facts) });
    } else {
      const id = columns[column] ?? "";
      groups.push({
        title: componentLabel(ctx.attempt, id),
        options: calls.get(id)?.options ?? [],
      });
    }
  };
  if (menu.column !== null) add(menu.column);
  else for (let i = 0; i < columns.length; i++) add(i);
  const shown = groups.filter((g) => g.options.length > 0);
  const patterns = menu.column === null ? patternsAt(ctx, menu.mode, entity) : [];
  // The new steps are the ones to look at next, here and in the list beside.
  const added = (ok: boolean) => {
    if (!ok) return;
    onClose();
    const now = useAttemptStore.getState().attempt;
    const after = now.flows.find((f) => f.operation === ctx.flow.operation);
    const first = Object.keys(after?.steps ?? {}).find(
      (id) => !(id in ctx.flow.steps) && after?.steps[id]?.type !== "respond",
    );
    if (first) useUi.getState().focusStep(ctx.flow.operation, first);
  };
  const section = useRef<HTMLElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  // Shown where it opened, scrolled into view if that is below the fold, and focused.
  useEffect(() => {
    section.current?.scrollIntoView({ block: "nearest" });
    first.current?.focus({ preventScroll: true });
  }, []);
  // The first choice is focused: the first pattern, when there are any.
  const firstKey = patterns.length > 0 ? undefined : shown[0]?.options[0]?.key;
  return (
    <section
      ref={section}
      aria-label="Add a step here"
      className="absolute z-20 flex max-h-80 flex-col gap-1.5 overflow-y-auto rounded-xl border border-accent-line bg-elevated p-2 shadow-pop"
      style={{ left: menu.left, top: menu.top, width: MENU_WIDTH }}
      data-testid="place-menu"
    >
      <header className="flex items-center">
        <h4 className="text-[13px] font-semibold">Add a step here</h4>
        <IconButton className="ml-auto h-6 w-6" aria-label="Close" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </header>
      {shown.length === 0 && patterns.length === 0 && (
        <p className="px-1 text-xs text-fg-subtle">Nothing of this kind can go here.</p>
      )}
      {patterns.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="px-1 text-[11px] font-semibold text-fg-subtle">Patterns</p>
          {patterns.map((pattern, i) => (
            <button
              key={pattern.key}
              ref={i === 0 ? first : undefined}
              type="button"
              onClick={() => added(commitPattern(ctx, menu.mode, pattern))}
              className={`rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-accent-soft hover:text-accent-fg ${FOCUS_RING}`}
            >
              <span className="font-semibold">{pattern.name}:</span> {pattern.label}
            </button>
          ))}
        </div>
      )}
      {shown.map((group) => (
        <div key={group.title} className="flex flex-col gap-0.5">
          <p className="px-1 text-[11px] font-semibold text-fg-subtle">{group.title}</p>
          {group.options.map((option) => (
            <button
              key={option.key}
              ref={option.key === firstKey ? first : undefined}
              type="button"
              onClick={() => added(commitStep(ctx, menu.mode, option.step))}
              className={`rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-accent-soft hover:text-accent-fg ${FOCUS_RING}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}
