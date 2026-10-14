import {
  BUILT_IN_FACTS,
  type Flow,
  hasFact,
  liveStepIds,
  outcomeTone,
  type StepInput,
} from "@archdrill/model";
import {
  ArrowDownToLine,
  ChevronDown,
  CornerDownRight,
  GitFork,
  MoreHorizontal,
  Plus,
  Reply,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { createContext, useContext, useMemo, useState } from "react";
import { stepNumbers } from "../../canvas/projection";
import type { AnyCommand } from "../../state/attempt-store";
import { activePack, catalogIndex } from "../../state/content";
import { useAttemptStore } from "../../state/store";
import { operationById, respondLabel, runsInBackground } from "../../state/triggers";
import { useUi } from "../../state/ui-store";
import { KindChip } from "../../ui/icons";
import { MenuItem, MenuLabel, Popover } from "../../ui/Popover";
import { FOCUS_RING } from "../../ui/primitives";
import { successStatus } from "./defaults";
import {
  type EditContext,
  type ExitChoice,
  type Position,
  removeStep,
  setExit,
  withPruning,
} from "./flow-edits";
import { commitStep, operationEntity } from "./pick";
import { hasTunableParams } from "./StepParams";
import { StepPicker } from "./StepPicker";
import { StepSettings } from "./StepSettings";
import { outcomeLabel, stepSentence } from "./sentences";
import { type Exit, type Sequence, type SequenceItem, sequenceOf } from "./sequence";
import { stepDetails } from "./step-label";
import { suggestNext } from "./suggestions";

/** Which picker is open; only one at a time keeps the list calm. */
interface PickerState {
  readonly open: string | null;
  readonly setOpen: (key: string | null) => void;
}

interface FlowView {
  readonly ctx: EditContext;
  readonly facts: ReadonlySet<string>;
  readonly picker: PickerState;
  readonly apply: (commands: readonly AnyCommand[]) => void;
}

const FlowContext = createContext<FlowView | null>(null);

function useFlowView(): FlowView {
  const view = useContext(FlowContext);
  if (!view) throw new Error("FlowSequence parts must be rendered inside FlowSequence.");
  return view;
}

/** Facts any of the operation's requests can have, across the scenarios' workloads. */
function operationFacts(operation: string): Set<string> {
  const facts = new Set<string>();
  for (const scenario of activePack.scenarios) {
    for (const cls of scenario.workload?.operations[operation]?.classes ?? []) {
      for (const fact of [...BUILT_IN_FACTS, ...cls.facts]) {
        if (hasFact(cls, fact)) facts.add(fact);
      }
    }
  }
  return facts;
}

/**
 * A flow as a list of steps, read top to bottom. Each step says what it does;
 * outcomes that leave the list (not found, an error…) show under it with
 * where they go, and can be changed in place.
 */
export function FlowSequence({ flow }: { readonly flow: Flow }) {
  const attempt = useAttemptStore((s) => s.attempt);
  const dispatchAll = useAttemptStore((s) => s.dispatchAll);
  const [open, setOpen] = useState<string | null>(null);
  const operation = operationById(flow.operation);
  const facts = useMemo(() => operationFacts(flow.operation), [flow.operation]);
  const sequence = useMemo(() => sequenceOf(flow, attempt), [flow, attempt]);
  if (!operation) return null;
  const ctx: EditContext = {
    flow,
    attempt,
    problem: activePack.problem,
    operation,
    catalog: catalogIndex,
    background: runsInBackground(operation),
  };
  const view: FlowView = {
    ctx,
    facts,
    picker: { open, setOpen },
    apply: (commands) => {
      dispatchAll(withPruning(attempt, flow.operation, commands));
      setOpen(null);
    },
  };
  const live = new Set(liveStepIds(flow, attempt));
  const parked = Object.keys(flow.steps).filter(
    (id) => !live.has(id) && flow.steps[id]?.type !== "respond",
  );
  return (
    <FlowContext.Provider value={view}>
      <div className="flex flex-col" data-testid="flow-steps">
        <SequenceList sequence={sequence} entry={{ kind: "root" }} main />
        {parked.length > 0 && <ParkedSteps flow={flow} ids={parked} />}
      </div>
    </FlowContext.Provider>
  );
}

function SequenceList({
  sequence,
  entry,
  main = false,
}: {
  readonly sequence: Sequence;
  /** Where the list's first step hangs: the start of the flow, or an outcome of a step. */
  readonly entry: Position;
  readonly main?: boolean;
}) {
  const { items, end } = sequence;
  if (items.length === 0 && end.kind === "respond" && entry.kind === "root") {
    return <RespondsAtOnce status={end.status} stepId={end.target} />;
  }
  if (items.length === 0 && end.kind === "empty") {
    return (
      <OpenEnd
        at={entry}
        pickerKey={
          entry.kind === "root" ? "root" : `exit:${entry.stepId}:${entry.outcomes.join(",")}`
        }
        title="What does the service do first?"
        main={main}
      />
    );
  }
  return (
    <ol className="flex flex-col">
      {items.map((item, index) => {
        const previous = items[index - 1];
        const into: Position = previous
          ? { kind: "after", stepId: previous.stepId, outcomes: previous.continuing }
          : entry;
        return (
          <li key={item.stepId} className="flex flex-col">
            {index > 0 && previous && (
              <Connector from={previous} into={into} before={item.stepId} />
            )}
            <StepCard item={item} into={into} />
          </li>
        );
      })}
      <li className="flex flex-col">
        <End sequence={sequence} main={main} />
      </li>
    </ol>
  );
}

/** A flow that answers before doing anything: its response, and a way to put a step first. */
function RespondsAtOnce({ status, stepId }: { readonly status: number; readonly stepId: string }) {
  const { ctx, picker } = useFlowView();
  const dispatch = useAttemptStore((s) => s.dispatch);
  const key = "root-insert";
  return (
    <div className="flex flex-col items-start gap-1.5">
      {picker.open === key && (
        <PickerFor
          key={key}
          mode={{ kind: "insert", at: { kind: "root" }, before: stepId }}
          title="Add a step before responding"
          onClose={() => picker.setOpen(null)}
        />
      )}
      <Popover
        label="How the request ends"
        trigger={({ toggle }) => (
          <button
            type="button"
            onClick={toggle}
            className={`flex items-center gap-2 rounded-full border border-ok-line bg-ok-soft py-1 pr-2.5 pl-1 text-[13px] font-medium text-ok-fg ${FOCUS_RING}`}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ok text-on-accent">
              <Reply className="h-3 w-3" aria-hidden="true" />
            </span>
            {stepSentence({ type: "respond", status }, ctx.attempt, ctx.background)}
            <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuLabel>Respond with</MenuLabel>
            <div className="flex flex-wrap gap-1 px-1.5 pb-1">
              {endStatuses(ctx).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    close();
                    dispatch("updateStep", { operation: ctx.flow.operation, stepId, status: s });
                  }}
                  aria-pressed={s === status}
                  className={`rounded-md border px-1.5 py-0.5 text-xs font-medium tabular-nums ${
                    s === status
                      ? "border-accent bg-accent-soft text-accent-fg"
                      : "border-line text-fg hover:bg-muted"
                  } ${FOCUS_RING}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
      </Popover>
      <button
        type="button"
        onClick={() => picker.setOpen(key)}
        className={`ml-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg-subtle hover:bg-muted hover:text-fg ${FOCUS_RING}`}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add a step before responding
      </button>
    </div>
  );
}

/** The line between two steps: which outcomes carry on, and a way to put a step in between. */
function Connector({
  from,
  into,
  before,
}: {
  readonly from: SequenceItem;
  readonly into: Position;
  readonly before: string;
}) {
  const { picker } = useFlowView();
  const key = `insert:${from.stepId}:${before}`;
  const label =
    from.exits.length > 0 ? `if ${from.continuing.map(outcomeLabel).join(" or ")}` : null;
  return (
    <div className="group relative ml-[13px] flex min-h-6 flex-col border-l-2 border-line py-1 pl-4">
      {label && <span className="text-[11px] text-fg-subtle">{label}</span>}
      {picker.open === key ? (
        <div className="-ml-4 py-1">
          <PickerFor
            key={key}
            mode={{ kind: "insert", at: into, before }}
            title="Insert a step here"
            onClose={() => picker.setOpen(null)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => picker.setOpen(key)}
          aria-label="Insert a step here"
          title="Insert a step here"
          className={`absolute top-1/2 -left-[9px] flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full border border-line-strong bg-surface text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:border-accent hover:text-accent-fg ${FOCUS_RING}`}
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function StepIcon({ step }: { readonly step: SequenceItem["step"] }) {
  const attempt = useAttemptStore((s) => s.attempt);
  if (step.type === "call") {
    const kind = attempt.architecture.components.find((c) => c.id === step.target)?.kind ?? "";
    return <KindChip kind={kind} size="sm" />;
  }
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-fg-muted">
      <GitFork className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
}

function StepCard({ item, into }: { readonly item: SequenceItem; readonly into: Position }) {
  const { ctx, apply, picker } = useFlowView();
  const [editing, setEditing] = useState(false);
  const { step, stepId } = item;
  const tunable = step.type === "call" && hasTunableParams(step.action);
  const highlight = () =>
    useUi.getState().setHover({
      components: new Set(step.type === "call" ? [step.target] : []),
      connections: new Set(),
      steps: new Set([stepId]),
      decisions: new Set(),
    });
  const insertKey = `before:${stepId}`;
  return (
    <div className="flex flex-col gap-1.5">
      {picker.open === insertKey && (
        <PickerFor
          key={insertKey}
          mode={{ kind: "insert", at: into, before: stepId }}
          title="Insert a step before this one"
          onClose={() => picker.setOpen(null)}
        />
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hovering only mirrors the step on the canvas, where it is numbered too */}
      <div
        className="group flex flex-col gap-1.5 rounded-xl border border-line bg-surface px-2.5 py-2 shadow-card hover:border-line-strong"
        onMouseEnter={highlight}
        onMouseLeave={() => useUi.getState().setHover(null)}
        data-testid={`step-${stepId}`}
      >
        <div className="flex items-center gap-2">
          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-on-accent">
            {item.number}
          </span>
          <StepIcon step={step} />
          <span className="min-w-0 flex-1 text-[13px] font-medium text-fg">
            {stepSentence(step, ctx.attempt, ctx.background)}
          </span>
          <Popover
            label="Step options"
            align="end"
            trigger={({ toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-label="Step options"
                className={`rounded-md p-1 text-fg-subtle opacity-60 group-hover:opacity-100 hover:bg-muted hover:text-fg ${FOCUS_RING}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            )}
          >
            {(close) => (
              <>
                {tunable && (
                  <MenuItem
                    onClick={() => {
                      setEditing(true);
                      close();
                    }}
                  >
                    <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /> Settings (timeouts,
                    batches, TTL…)
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() => {
                    picker.setOpen(insertKey);
                    close();
                  }}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" /> Insert a step before
                </MenuItem>
                <MenuItem
                  tone="danger"
                  onClick={() => {
                    // The card goes away under the pointer; nothing will un-highlight it.
                    useUi.getState().setHover(null);
                    apply(removeStep(ctx, stepId, item.continuing));
                    close();
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove step
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
        {stepDetails(step).length > 0 && (
          <div className="flex flex-wrap gap-1 pl-7">
            {stepDetails(step).map((detail) => (
              <span
                key={detail}
                className="rounded bg-muted px-1.5 text-[11px] font-medium text-fg-muted"
              >
                {detail}
              </span>
            ))}
          </div>
        )}
        {item.exits.length > 0 && (
          <div className="flex flex-wrap gap-1 pl-7">
            {item.exits.map((exit) => (
              <ExitChip key={exit.outcome} item={item} exit={exit} />
            ))}
          </div>
        )}
      </div>
      {editing && step.type === "call" && (
        <StepSettings
          operation={ctx.flow.operation}
          stepId={stepId}
          step={step}
          background={ctx.background}
          onClose={() => setEditing(false)}
        />
      )}
      {item.exits
        .filter((exit) => exit.kind === "branch" || exit.kind === "open")
        .map((exit) => (
          <div
            key={exit.outcome}
            className="ml-5 flex flex-col gap-1 border-l-2 border-dashed border-line pl-3"
          >
            <span className="text-[11px] font-medium text-fg-subtle">
              If {outcomeLabel(exit.outcome)}:
            </span>
            {exit.kind === "branch" ? (
              <SequenceList
                sequence={exit.branch}
                entry={{ kind: "after", stepId, outcomes: [exit.outcome] }}
              />
            ) : (
              <OpenEnd
                at={{ kind: "after", stepId, outcomes: [exit.outcome] }}
                pickerKey={`exit:${stepId}:${exit.outcome}`}
                title={`If ${outcomeLabel(exit.outcome)}, what happens?`}
              />
            )}
          </div>
        ))}
    </div>
  );
}

const EXIT_TONES: Readonly<Record<string, string>> = {
  positive: "border-ok-line text-ok-fg",
  absent: "border-warn-line text-warn-fg",
  negative: "border-line-strong text-fg-muted",
  conflict: "border-accent-line text-accent-fg",
  error: "border-bad-line text-bad-fg",
};

function exitTarget(exit: Exit, background: boolean): string {
  switch (exit.kind) {
    case "respond":
      return background ? respondLabel(exit.status, true) : String(exit.status);
    case "goto":
      return `step ${exit.number}`;
    case "branch":
      return "steps below";
    case "open":
      return "decide…";
  }
}

/** An outcome that leaves the list, and where it goes; click to change it. */
function ExitChip({ item, exit }: { readonly item: SequenceItem; readonly exit: Exit }) {
  const { ctx, apply, picker } = useFlowView();
  const target = exitTarget(exit, ctx.background);
  const tone = EXIT_TONES[outcomeTone(exit.outcome)] ?? EXIT_TONES.negative;
  const choose = (choice: ExitChoice) => apply(setExit(ctx, item.stepId, [exit.outcome], choice));
  return (
    <Popover
      label={`What happens if ${outcomeLabel(exit.outcome)}`}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={`If ${outcomeLabel(exit.outcome)}: ${target}`}
          className={`flex items-center gap-1 rounded-md border bg-surface px-1.5 py-0.5 text-[11px] font-medium ${tone} ${
            exit.kind === "open" ? "border-dashed" : ""
          } hover:bg-muted ${FOCUS_RING}`}
        >
          {outcomeLabel(exit.outcome)}
          <span className="text-fg-subtle">→</span>
          {target}
          <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
        </button>
      )}
    >
      {(close) => (
        <ExitChoices
          currentStatus={exit.kind === "respond" ? exit.status : null}
          canCarryOn
          onChoose={(choice) => {
            close();
            choose(choice);
            if (choice.kind === "open") {
              picker.setOpen(`exit:${item.stepId}:${exit.outcome}`);
            }
          }}
          nextOf={item}
        />
      )}
    </Popover>
  );
}

/** Statuses to end with, success first. */
function endStatuses(ctx: EditContext): number[] {
  if (ctx.background) return [200, 503];
  const success = successStatus(ctx.operation, ctx.problem, ctx.attempt);
  return [...new Set([success, ...ctx.operation.successStatuses, 400, 404, 409, 429, 503])];
}

function ExitChoices({
  currentStatus,
  onChoose,
  nextOf,
  canCarryOn,
}: {
  /** The status the outcome ends with now, if it ends with one. */
  readonly currentStatus: number | null;
  readonly onChoose: (choice: ExitChoice) => void;
  readonly nextOf: SequenceItem;
  /** Offer to carry on like the step's continuing outcomes (not for the list's own end). */
  readonly canCarryOn: boolean;
}) {
  const { ctx } = useFlowView();
  const numbers = stepNumbers(ctx.flow, ctx.attempt);
  const numbered = [...numbers.keys()].filter((id) => id !== nextOf.stepId);
  const next = canCarryOn
    ? nextOf.continuing.map((o) => nextOf.step.next[o]).find((id) => id !== undefined)
    : undefined;
  return (
    <>
      <MenuLabel>End with</MenuLabel>
      <div className="flex flex-wrap gap-1 px-1.5 pb-1">
        {endStatuses(ctx).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => onChoose({ kind: "respond", status })}
            aria-pressed={currentStatus === status}
            title={respondLabel(status, ctx.background)}
            className={`rounded-md border px-1.5 py-0.5 text-xs font-medium tabular-nums ${
              currentStatus === status
                ? "border-accent bg-accent-soft text-accent-fg"
                : "border-line text-fg hover:bg-muted"
            } ${FOCUS_RING}`}
          >
            {ctx.background ? respondLabel(status, true) : status}
          </button>
        ))}
      </div>
      {next !== undefined && (
        <MenuItem onClick={() => onChoose({ kind: "goto", target: next })}>
          <ArrowDownToLine className="h-4 w-4" aria-hidden="true" /> Carry on like{" "}
          {nextOf.continuing.map(outcomeLabel).join(" or ")}
        </MenuItem>
      )}
      <MenuItem onClick={() => onChoose({ kind: "open" })}>
        <CornerDownRight className="h-4 w-4" aria-hidden="true" /> Do something else first…
      </MenuItem>
      {numbered.length > 0 && (
        <>
          <MenuLabel>Go to step</MenuLabel>
          <div className="flex flex-wrap gap-1 px-1.5 pb-1">
            {numbered.map((id) => {
              const step = ctx.flow.steps[id];
              return step ? (
                <button
                  key={id}
                  type="button"
                  onClick={() => onChoose({ kind: "goto", target: id })}
                  title={stepSentence(step, ctx.attempt, ctx.background)}
                  className={`rounded-md border border-line px-1.5 py-0.5 text-xs text-fg hover:bg-muted ${FOCUS_RING}`}
                >
                  {numbers.get(id)}
                </button>
              ) : null;
            })}
          </div>
        </>
      )}
    </>
  );
}

/** What closes a list: its response, a jump, or the place for the next step. */
function End({ sequence, main }: { readonly sequence: Sequence; readonly main: boolean }) {
  const { ctx, apply, picker } = useFlowView();
  const last = sequence.items.at(-1);
  const { end } = sequence;
  if (!last) return null;
  if (end.kind === "open" || end.kind === "empty") {
    // An end that leads nowhere known (a dangling link) still takes the next step.
    const outcomes = end.kind === "open" ? end.outcomes : last.continuing;
    return (
      <div className="ml-[13px] flex flex-col gap-1 border-l-2 border-line pt-1 pl-4">
        {last.exits.length > 0 && outcomes.length > 0 && (
          <span className="text-[11px] text-fg-subtle">
            if {outcomes.map(outcomeLabel).join(" or ")}
          </span>
        )}
        <div className="-ml-4">
          <OpenEnd
            at={{ kind: "after", stepId: last.stepId, outcomes }}
            pickerKey={`end:${last.stepId}`}
            title="Then…"
            main={main}
          />
        </div>
      </div>
    );
  }
  const label =
    end.kind === "respond"
      ? ctx.background
        ? `Finish: ${respondLabel(end.status, true)}`
        : `Respond ${respondLabel(end.status, false)}`
      : `Carry on at step ${end.number}`;
  const insertKey = `end-insert:${last.stepId}`;
  return (
    <div className="flex flex-col">
      <div className="ml-[13px] flex min-h-5 flex-col border-l-2 border-line pl-4">
        {last.exits.length > 0 && (
          <span className="pt-1 text-[11px] text-fg-subtle">
            if {last.continuing.map(outcomeLabel).join(" or ")}
          </span>
        )}
      </div>
      {picker.open === insertKey && end.kind === "respond" && (
        <PickerFor
          key={insertKey}
          mode={{
            kind: "insert",
            at: { kind: "after", stepId: last.stepId, outcomes: last.continuing },
            before: end.target,
          }}
          title="Add a step before responding"
          onClose={() => picker.setOpen(null)}
        />
      )}
      <div className="flex flex-col items-start gap-1">
        <Popover
          label="How the request ends"
          trigger={({ toggle }) => (
            <button
              type="button"
              onClick={toggle}
              className={`flex items-center gap-2 rounded-full border border-ok-line bg-ok-soft py-1 pr-2.5 pl-1 text-[13px] font-medium text-ok-fg hover:brightness-95 ${FOCUS_RING}`}
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ok text-on-accent">
                <Reply className="h-3 w-3" aria-hidden="true" />
              </span>
              {label}
              <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
            </button>
          )}
        >
          {(close) => (
            <ExitChoices
              currentStatus={end.kind === "respond" ? end.status : null}
              canCarryOn={false}
              nextOf={last}
              onChoose={(choice) => {
                close();
                apply(setExit(ctx, last.stepId, last.continuing, choice));
                if (choice.kind === "open") {
                  picker.setOpen(`end:${last.stepId}`);
                }
              }}
            />
          )}
        </Popover>
        {end.kind === "respond" && (
          <button
            type="button"
            onClick={() => picker.setOpen(insertKey)}
            className={`ml-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg-subtle hover:bg-muted hover:text-fg ${FOCUS_RING}`}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add a step before responding
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Where the next step goes. The main list keeps its picker open; elsewhere a
 * few likely steps and an Add a step button stay out of the way until needed.
 */
function OpenEnd({
  at,
  title,
  pickerKey: key,
  main = false,
}: {
  readonly at: Position;
  readonly title: string;
  /** Names this place for the one-open-picker state: the root, a list's end, or an outcome. */
  readonly pickerKey: string;
  readonly main?: boolean;
}) {
  const { ctx, facts, picker } = useFlowView();
  const active = picker.open === key || (picker.open === null && main);
  if (active) {
    return (
      <PickerFor
        key={key}
        mode={{ kind: "append", at }}
        title={title}
        onClose={picker.open === key ? () => picker.setOpen(null) : undefined}
      />
    );
  }
  const slot =
    at.kind === "root"
      ? { operation: ctx.flow.operation, attach: { to: "root" as const } }
      : {
          operation: ctx.flow.operation,
          attach: { to: "outcome" as const, stepId: at.stepId, outcome: at.outcomes[0] ?? "" },
        };
  const quick = suggestNext({
    attempt: ctx.attempt,
    flow: ctx.flow,
    slot,
    problem: ctx.problem,
    operation: ctx.operation,
    catalog: ctx.catalog,
    background: ctx.background,
    defaultEntity: operationEntity(ctx.flow.operation),
    facts,
  }).slice(0, 3);
  return (
    <div className="flex flex-wrap items-center gap-1.5 py-1" data-tour="open-slot">
      {quick.map((s) => (
        <QuickStep
          key={s.key}
          step={s.step}
          onChoose={() => commitStep(ctx, { kind: "append", at }, s.step)}
        />
      ))}
      <button
        type="button"
        onClick={() => picker.setOpen(key)}
        className={`flex items-center gap-1 rounded-lg border border-dashed border-line-strong px-2 py-1 text-xs font-medium text-fg-muted hover:border-accent hover:text-accent-fg ${FOCUS_RING}`}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add a step
      </button>
    </div>
  );
}

function QuickStep({
  step,
  onChoose,
}: {
  readonly step: StepInput;
  readonly onChoose: () => void;
}) {
  const { ctx } = useFlowView();
  const label = stepSentence(step, ctx.attempt, ctx.background);
  return (
    <button
      type="button"
      onClick={onChoose}
      title={`Add: ${label}`}
      className={`max-w-full truncate rounded-lg border border-line bg-surface px-2 py-1 text-xs font-medium text-fg shadow-card hover:border-accent-line hover:bg-accent-soft ${FOCUS_RING}`}
    >
      {label}
    </button>
  );
}

function PickerFor({
  mode,
  title,
  onClose,
}: {
  readonly mode: Parameters<typeof StepPicker>[0]["mode"];
  readonly title: string;
  readonly onClose?: (() => void) | undefined;
}) {
  const { ctx, facts } = useFlowView();
  return (
    <div data-tour="open-slot">
      <StepPicker
        ctx={ctx}
        mode={mode}
        title={title}
        facts={facts}
        {...(onClose ? { onClose } : {})}
      />
    </div>
  );
}

/** Steps nothing leads to any more (from older designs), so no work is lost silently. */
function ParkedSteps({ flow, ids }: { readonly flow: Flow; readonly ids: readonly string[] }) {
  const { ctx, apply } = useFlowView();
  return (
    <div className="mt-3 flex flex-col gap-1 rounded-lg bg-sunken p-2">
      <p className="text-xs font-medium text-fg-muted">Not reachable from the first step</p>
      {ids.map((id) => {
        const step = flow.steps[id];
        return step ? (
          <div key={id} className="flex items-center gap-2 text-xs text-fg-muted">
            <span className="flex-1">{stepSentence(step, ctx.attempt, ctx.background)}</span>
            <button
              type="button"
              aria-label="Remove step"
              onClick={() =>
                apply([{ name: "removeStep", args: { operation: flow.operation, stepId: id } }])
              }
              className={`rounded p-1 text-fg-subtle hover:bg-muted hover:text-fg ${FOCUS_RING}`}
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        ) : null;
      })}
    </div>
  );
}
