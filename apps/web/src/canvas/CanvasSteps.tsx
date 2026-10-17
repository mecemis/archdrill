import { NodeToolbar, Panel, Position } from "@xyflow/react";
import { ChevronLeft, ChevronRight, ListPlus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addAtSlot,
  cursorPositions,
  describeCursor,
  editContextFor,
  modeOf,
  sameMode,
  slotFor,
} from "../panels/flow/cursor";
import { operationEntity } from "../panels/flow/pick";
import { componentLabel } from "../panels/flow/step-label";
import { callOptions } from "../panels/flow/step-options";
import { activePack, catalogIndex } from "../state/content";
import { useAttemptStore } from "../state/store";
import { useToasts } from "../state/toasts";
import { useUi } from "../state/ui-store";
import { KindChip } from "../ui/icons";
import { FOCUS_RING, IconButton, Select } from "../ui/primitives";

/** What adding on the canvas reads, recomputed only when the flows or the architecture change. */
function useAddingContext(operation: string | undefined) {
  const flows = useAttemptStore((s) => s.attempt.flows);
  const architecture = useAttemptStore((s) => s.attempt.architecture);
  // The attempt is read fresh: its flows and architecture are what the result depends on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: flows and architecture stand for the attempt
  return useMemo(() => {
    if (operation === undefined) return null;
    const attempt = useAttemptStore.getState().attempt;
    const ctx = editContextFor(attempt, operation);
    return ctx ? { ctx, positions: cursorPositions(ctx.flow, attempt) } : null;
  }, [operation, flows, architecture]);
}

/**
 * Adding steps on the canvas: arms a slot at the flow's first open place, so
 * that clicking a component offers its steps next to it.
 */
export function AddStepsButton() {
  const operation = useUi((s) => s.operation);
  const slot = useUi((s) => s.slot);
  const adding = useAddingContext(operation);
  if (!adding) return null;
  const on = slot?.source === "canvas";
  const [first] = adding.positions;
  return (
    <IconButton
      active={on}
      aria-pressed={on}
      aria-label="Add steps on the canvas"
      disabled={!on && first === undefined}
      title={
        on
          ? "Stop adding steps"
          : first === undefined
            ? "Every branch already leads somewhere: change one in the Flow panel to add a step there"
            : "Add steps: click a component to see what the service can do with it"
      }
      onClick={() => {
        const ui = useUi.getState();
        if (on) return ui.armSlot(null);
        if (first) ui.armSlot(slotFor(operation, first, "canvas"));
      }}
      className={`border border-line shadow-card ${on ? "" : "bg-elevated"}`}
    >
      <ListPlus className="h-4 w-4" />
    </IconButton>
  );
}

/** Where the next step goes while adding on the canvas, and the way to move it or stop. */
export function CursorBar() {
  const slot = useUi((s) => s.slot);
  // A picker in the Flow panel says where its step goes itself.
  const adding = useAddingContext(slot?.source === "canvas" ? slot.operation : undefined);
  if (!slot || !adding) return null;
  const { ctx, positions } = adding;
  const mode = modeOf(slot);
  const index = positions.findIndex((m) => sameMode(m, mode));
  const move = (by: number) => {
    const next = positions[(Math.max(0, index) + by + positions.length) % positions.length];
    if (next) useUi.getState().armSlot(slotFor(slot.operation, next, "canvas"));
  };
  return (
    <Panel position="bottom-center">
      <div
        className="flex max-w-[44rem] items-center gap-2 rounded-xl border border-accent-line bg-elevated py-1.5 pr-1.5 pl-3 text-sm shadow-pop"
        data-testid="cursor-bar"
      >
        <span className="min-w-0 text-fg-muted">
          <span className="font-semibold text-fg">{ctx.operation.label}</span>: adding{" "}
          <span className="text-fg">
            {describeCursor(mode, ctx.flow, ctx.attempt, ctx.background)}
          </span>
          . Click a highlighted component.
        </span>
        {positions.length > 1 && (
          <span className="flex shrink-0">
            <IconButton
              className="h-7 w-7"
              aria-label="Previous place"
              title="Previous place"
              onClick={() => move(-1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
            <IconButton
              className="h-7 w-7"
              aria-label="Next place"
              title="Next place"
              onClick={() => move(1)}
            >
              <ChevronRight className="h-4 w-4" />
            </IconButton>
          </span>
        )}
        <button
          type="button"
          onClick={() => useUi.getState().armSlot(null)}
          className={`shrink-0 rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold text-on-accent ${FOCUS_RING}`}
        >
          Done
        </button>
      </div>
    </Panel>
  );
}

/**
 * The steps the service can take with a component clicked on the canvas,
 * shown next to it; choosing one adds it at the armed slot.
 */
export function StepMenu() {
  const slot = useUi((s) => s.slot);
  const target = useUi((s) => s.canvasTarget);
  const adding = useAddingContext(slot?.operation);
  // The operation's own entity, until the menu is told otherwise for this operation.
  const [choice, setChoice] = useState<{ operation: string; entity: string } | null>(null);
  const operation = slot?.operation ?? "";
  const entity = choice?.operation === operation ? choice.entity : operationEntity(operation);
  const handler = adding?.ctx.flow.handler;
  const attempt = adding?.ctx.attempt;
  const options = useMemo(
    () =>
      attempt && handler && target
        ? callOptions(attempt, handler, entity, catalogIndex).get(target)
        : undefined,
    [attempt, handler, entity, target],
  );
  const first = useRef<HTMLButtonElement>(null);
  // Opening the menu moves focus into it, so a keyboard can choose straight away.
  useEffect(() => {
    if (options) first.current?.focus({ preventScroll: true });
  }, [options]);
  if (!slot || !target || !adding || !options || !attempt || !handler) return null;
  const component = attempt.architecture.components.find((c) => c.id === target);
  const close = () => useUi.getState().setCanvasTarget(null);
  const choose = (step: (typeof options.options)[number]["step"]) => {
    if (addAtSlot(slot, step)) return;
    useToasts
      .getState()
      .notify("That place in the flow is gone. Pick where to add from the bar below.", "error");
  };
  return (
    <NodeToolbar nodeId={target} isVisible position={Position.Right} offset={12}>
      <section
        aria-label={`Steps with ${componentLabel(attempt, target)}`}
        className="flex w-64 flex-col gap-1.5 rounded-xl border border-accent-line bg-elevated p-2 shadow-pop"
        data-testid="step-menu"
      >
        <header className="flex items-center gap-1.5">
          <KindChip kind={component?.kind ?? ""} size="xs" />
          <h4 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">
            {componentLabel(attempt, target)}
          </h4>
          <IconButton className="h-6 w-6" aria-label="Close" onClick={close}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </header>
        {!options.connected && (
          <p className="px-1 text-[11px] text-fg-subtle">
            Not connected yet: choosing a step connects {componentLabel(attempt, handler)} to it.
          </p>
        )}
        {activePack.problem.entities.length > 1 &&
          options.options.some((o) => o.step.type === "call" && o.step.entity !== undefined) && (
            <Select
              aria-label="Data the call works on"
              value={entity}
              onChange={(e) => setChoice({ operation, entity: e.target.value })}
              className="h-7 text-xs"
            >
              {activePack.problem.entities.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.name}
                </option>
              ))}
            </Select>
          )}
        <div className="flex max-h-64 flex-col overflow-y-auto">
          {options.options.map((option, index) => (
            <button
              key={option.key}
              ref={index === 0 ? first : undefined}
              type="button"
              onClick={() => choose(option.step)}
              className={`rounded-lg px-2 py-1.5 text-left text-[13px] text-fg hover:bg-accent-soft hover:text-accent-fg ${FOCUS_RING}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>
    </NodeToolbar>
  );
}
