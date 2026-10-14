import {
  type Attempt,
  BUILT_IN_FACTS,
  type Flow,
  feasibleOutcomes,
  hasFact,
  liveStepIds,
  type Step,
} from "@archdrill/model";
import { CornerDownRight, GitFork, Plus, SlidersHorizontal, Trash2, Unlink } from "lucide-react";
import { type ReactNode, useState } from "react";
import { stepNumbers } from "../../canvas/projection";
import { activePack, catalogIndex } from "../../state/content";
import { useAttemptStore } from "../../state/store";
import { operationById, respondLabel, runsInBackground } from "../../state/triggers";
import { type Attach, type Slot, useUi } from "../../state/ui-store";
import { KindChip } from "../../ui/icons";
import { OutcomeChip } from "../../ui/outcome";
import { Button, FOCUS_RING } from "../../ui/primitives";
import { AddStepForm } from "./AddStepForm";
import { addStepToSlot } from "./add-step";
import { hasTunableParams, paramsUpdate, StepParams, type TunableValues } from "./StepParams";
import { stepTitle } from "./step-label";
import { type Suggestion, suggestNext } from "./suggestions";

interface TreeContext {
  readonly flow: Flow;
  readonly numbers: ReadonlyMap<string, number>;
  /** Position key → whether the step there is drawn in full or as a link to its first occurrence. */
  readonly plan: ReadonlyMap<string, "full" | "reference">;
  readonly highlighted: ReadonlySet<string>;
  /** A consumer or job: final statuses mean done or try again, not an HTTP answer. */
  readonly background: boolean;
}

const ROOT_POSITION = "root";
const positionKey = (stepId: string, outcome: string) => `${stepId}:${outcome}`;

/**
 * Decides, before rendering, where each shared step is drawn in full: at its
 * first position in depth-first order. Later positions show a link. Computing
 * this up front keeps rendering pure (StrictMode renders twice).
 */
export function planTree(flow: Flow, attempt: Attempt): Map<string, "full" | "reference"> {
  const plan = new Map<string, "full" | "reference">();
  const seen = new Set<string>();
  const visit = (stepId: string, position: string) => {
    const step = flow.steps[stepId];
    if (!step) return;
    if (step.type === "respond") {
      plan.set(position, "full");
      return;
    }
    if (seen.has(stepId)) {
      plan.set(position, "reference");
      return;
    }
    seen.add(stepId);
    plan.set(position, "full");
    for (const outcome of feasibleOutcomes(step, attempt)) {
      const next = step.next[outcome];
      if (next !== undefined) visit(next, positionKey(stepId, outcome));
    }
  };
  if (flow.root !== null) visit(flow.root, ROOT_POSITION);
  return plan;
}

export function StepTree({ flow }: { readonly flow: Flow }) {
  const hover = useUi((s) => s.hover);
  const pinned = useUi((s) => s.pinned);
  const highlighted = (hover ?? pinned?.highlight)?.steps ?? new Set<string>();
  const attempt = useAttemptStore((s) => s.attempt);
  const ctx: TreeContext = {
    flow,
    numbers: stepNumbers(flow, attempt),
    plan: planTree(flow, attempt),
    highlighted,
    background: runsInBackground(operationById(flow.operation)),
  };
  const live = new Set(liveStepIds(flow, attempt));
  const orphans = Object.keys(flow.steps).filter((id) => !live.has(id));

  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="step-tree">
      {flow.root === null ? (
        <SlotControl
          slot={{ operation: flow.operation, attach: { to: "root" } }}
          flow={flow}
          label="Add the first step"
        />
      ) : (
        <StepBlock
          stepId={flow.root}
          position={ROOT_POSITION}
          attachedFrom={{ to: "root" }}
          ctx={ctx}
        />
      )}
      {orphans.length > 0 && <OrphanList flow={flow} orphans={orphans} />}
    </div>
  );
}

function StepBlock({
  stepId,
  position,
  attachedFrom,
  ctx,
}: {
  stepId: string;
  position: string;
  attachedFrom: Attach;
  ctx: TreeContext;
}) {
  const attempt = useAttemptStore((s) => s.attempt);
  const step = ctx.flow.steps[stepId];
  if (!step) return null;
  const number = ctx.numbers.get(stepId);
  if (ctx.plan.get(position) === "reference") {
    return (
      <p className="flex items-center gap-1.5 py-0.5 text-xs text-fg-subtle">
        <CornerDownRight className="h-3.5 w-3.5" aria-hidden="true" />
        continues at step {number} ({stepTitle(step, attempt)})
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <StepRow stepId={stepId} step={step} number={number} attachedFrom={attachedFrom} ctx={ctx} />
      {step.type !== "respond" && (
        <ul className="ml-3 flex flex-col gap-1 border-l border-line pl-3">
          {feasibleOutcomes(step, attempt).map((outcome) => {
            const next = step.next[outcome];
            const attach: Attach = { to: "outcome", stepId, outcome };
            return (
              <li key={outcome} className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  <OutcomeChip outcome={outcome} />
                  {next !== undefined && (
                    <UnlinkButton flow={ctx.flow} stepId={stepId} outcome={outcome} />
                  )}
                </div>
                {next === undefined ? (
                  <SlotControl
                    slot={{ operation: ctx.flow.operation, attach }}
                    flow={ctx.flow}
                    label="Add step"
                  />
                ) : (
                  <StepBlock
                    stepId={next}
                    position={positionKey(stepId, outcome)}
                    attachedFrom={attach}
                    ctx={ctx}
                  />
                )}
              </li>
            );
          })}
          {inactiveLinks(step, attempt).map((outcome) => (
            <li key={outcome} className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <span className="opacity-50">
                <OutcomeChip outcome={outcome} />
              </span>
              never happens in this design
              <UnlinkButton flow={ctx.flow} stepId={stepId} outcome={outcome} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Outcomes that are linked but cannot occur (e.g. negative hits without negative caching). */
function inactiveLinks(step: Step, attempt: Attempt): string[] {
  if (step.type === "respond") return [];
  const feasible = new Set(feasibleOutcomes(step, attempt));
  return Object.keys(step.next).filter((outcome) => !feasible.has(outcome));
}

function StepRow({
  stepId,
  step,
  number,
  attachedFrom,
  ctx,
}: {
  stepId: string;
  step: Step;
  number: number | undefined;
  attachedFrom: Attach;
  ctx: TreeContext;
}) {
  const attempt = useAttemptStore((s) => s.attempt);
  const dispatch = useAttemptStore((s) => s.dispatch);
  const slot = useUi((s) => s.slot);
  const operation = ctx.flow.operation;
  const insertSlot: Slot = { operation, attach: attachedFrom, before: stepId };
  const inserting = slot?.before === stepId && slot.operation === operation;
  const isLeaf = step.type === "respond";
  const [choosing, setChoosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const tunable = step.type === "call" && hasTunableParams(step.action);
  const continuations = isLeaf ? [] : distinctContinuations(step, attempt);
  const remove = (bypass?: string) => {
    setChoosing(false);
    dispatch("removeStep", { operation, stepId, prune: true, ...(bypass ? { bypass } : {}) });
  };
  // With several different continuations, ask which one should take the removed step's place.
  const onRemove = () => {
    if (continuations.length <= 1) remove(continuations[0]?.outcome);
    else setChoosing(true);
  };
  return (
    <>
      {inserting && <AddStepForm slot={insertSlot} flow={ctx.flow} />}
      <div
        className={`group flex items-center gap-2 rounded-md px-1.5 py-1 ${
          ctx.highlighted.has(stepId) ? "bg-warn-soft" : isLeaf ? "" : "bg-sunken"
        }`}
      >
        {!isLeaf && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-on-accent">
            {number}
          </span>
        )}
        <span className={isLeaf ? "text-fg-muted" : "font-medium text-fg"}>
          {isLeaf ? "→ " : ""}
          {stepTitle(step, attempt, ctx.background)}
        </span>
        <span className="ml-auto flex gap-0.5 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
          {tunable && (
            <IconButton label="Edit this step's settings" onClick={() => setEditing(!editing)}>
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {!isLeaf && (
            <IconButton
              label="Insert a step before this one"
              onClick={() => useUi.getState().armSlot(insertSlot)}
            >
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
          )}
          <IconButton label="Remove step" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </span>
      </div>
      {editing && step.type === "call" && (
        <StepSettings
          operation={operation}
          stepId={stepId}
          step={step}
          background={ctx.background}
          onClose={() => setEditing(false)}
        />
      )}
      {choosing && (
        <div className="flex flex-col gap-1 rounded-md border border-bad-line bg-bad-soft p-2 text-xs">
          <p className="font-medium text-bad-fg">Remove this step and keep what follows…</p>
          {continuations.map(({ outcome, target }) => (
            <button
              key={outcome}
              type="button"
              onClick={() => remove(outcome)}
              className="self-start rounded px-1.5 py-0.5 text-left text-fg hover:bg-bad-soft"
            >
              …on {outcome}: {target}
            </button>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => remove()}
              className="rounded px-1.5 py-0.5 font-medium text-bad-fg hover:bg-bad-soft"
            >
              Remove it and everything after it
            </button>
            <button
              type="button"
              onClick={() => setChoosing(false)}
              className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** Linked outcomes with distinct targets, labelled by what they lead to. */
function distinctContinuations(
  step: Step,
  attempt: Attempt,
): { outcome: string; target: string }[] {
  if (step.type === "respond") return [];
  const flow = attempt.flows.find((f) => Object.values(f.steps).includes(step));
  const seen = new Set<string>();
  const result: { outcome: string; target: string }[] = [];
  for (const outcome of feasibleOutcomes(step, attempt)) {
    const target = step.next[outcome];
    if (target === undefined || seen.has(target)) continue;
    seen.add(target);
    const next = flow?.steps[target];
    result.push({ outcome, target: next ? stepTitle(next, attempt) : target });
  }
  return result;
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

/** The entity an operation works on, from the scenarios' workloads. */
function operationEntity(operation: string): string {
  for (const scenario of activePack.scenarios) {
    const entity = scenario.workload?.operations[operation]?.entity;
    if (entity) return entity;
  }
  return activePack.problem.entities[0]?.name ?? "";
}

const RESPOND_TONES = (status: number) =>
  status >= 500
    ? "border-bad-line text-bad-fg hover:bg-bad-soft"
    : status >= 400
      ? "border-warn-line text-warn-fg hover:bg-warn-soft"
      : "border-ok-line text-ok-fg hover:bg-ok-soft";

function SuggestionChip({
  suggestion,
  slot,
  background,
}: {
  readonly suggestion: Suggestion;
  readonly slot: Slot;
  readonly background: boolean;
}) {
  const attempt = useAttemptStore((s) => s.attempt);
  const { step } = suggestion;
  const label =
    step.type === "respond"
      ? `Respond ${respondLabel(step.status, background)}`
      : stepTitle({ ...step, next: {} } as Step, attempt, background);
  const kind =
    step.type === "call"
      ? attempt.architecture.components.find((c) => c.id === step.target)?.kind
      : undefined;
  const tone =
    step.type === "respond"
      ? RESPOND_TONES(step.status)
      : "border-line text-fg hover:border-accent-line hover:bg-accent-soft";
  return (
    <button
      type="button"
      onClick={() => addStepToSlot(slot, step)}
      aria-label={`Add step: ${label}`}
      title={`Add: ${label}`}
      className={`flex max-w-full items-center gap-1.5 rounded-lg border bg-surface px-2 py-1 text-xs font-medium shadow-card transition-colors ${FOCUS_RING} ${tone}`}
    >
      {kind && <KindChip kind={kind} size="xs" />}
      {step.type === "logic" && (
        <GitFork className="h-3.5 w-3.5 text-fg-subtle" aria-hidden="true" />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * An open branch: one-click suggestions for what usually comes next, and
 * the full form for anything else.
 */
function SlotControl({ slot, flow, label }: { slot: Slot; flow: Flow; label: string }) {
  const attempt = useAttemptStore((s) => s.attempt);
  const armed = useUi((s) => s.slot);
  const isArmed =
    armed !== null &&
    armed.before === undefined &&
    armed.operation === slot.operation &&
    JSON.stringify(armed.attach) === JSON.stringify(slot.attach);
  if (isArmed) return <AddStepForm slot={slot} flow={flow} />;
  const operation = operationById(slot.operation);
  const background = runsInBackground(operation);
  const suggestions = operation
    ? suggestNext({
        attempt,
        flow,
        slot,
        problem: activePack.problem,
        operation,
        catalog: catalogIndex,
        background,
        defaultEntity: operationEntity(slot.operation),
        facts: operationFacts(slot.operation),
      })
    : [];
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-tour="open-slot">
      {suggestions.map((s) => (
        <SuggestionChip key={s.key} suggestion={s} slot={slot} background={background} />
      ))}
      <button
        type="button"
        onClick={() => useUi.getState().armSlot(slot)}
        className={`flex items-center gap-1 rounded-lg border border-dashed border-line-strong px-2 py-1 text-xs font-medium text-fg-muted hover:border-accent hover:text-accent-fg ${FOCUS_RING}`}
        title="Choose any step: a call, a decision, a response, or a jump to an existing step"
        {...(slot.attach.to === "root" ? { "data-tour": "first-step" } : {})}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </button>
    </div>
  );
}

function UnlinkButton({ flow, stepId, outcome }: { flow: Flow; stepId: string; outcome: string }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  return (
    <IconButton
      label={`Detach what happens on ${outcome}`}
      onClick={() =>
        dispatch("linkOutcome", { operation: flow.operation, stepId, outcome, target: null })
      }
    >
      <Unlink className="h-3 w-3" />
    </IconButton>
  );
}

function OrphanList({ flow, orphans }: { flow: Flow; orphans: readonly string[] }) {
  const attempt = useAttemptStore((s) => s.attempt);
  const dispatch = useAttemptStore((s) => s.dispatch);
  return (
    <div className="mt-3 flex flex-col gap-1 rounded-md bg-sunken p-2">
      <p className="text-xs font-medium text-fg-muted">Not reachable from the first step</p>
      {orphans.map((id) => {
        const step = flow.steps[id];
        return step ? (
          <div key={id} className="flex items-center gap-2 text-xs text-fg-muted">
            {stepTitle(step, attempt)}
            <IconButton
              label="Remove step"
              onClick={() => dispatch("removeStep", { operation: flow.operation, stepId: id })}
            >
              <Trash2 className="h-3 w-3" />
            </IconButton>
          </div>
        ) : null;
      })}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded p-1 text-fg-subtle hover:bg-track hover:text-fg"
    >
      {children}
    </button>
  );
}

/** Edits a call step's parameters; changes apply together, as one undoable change. */
function StepSettings({
  operation,
  stepId,
  step,
  background,
  onClose,
}: {
  readonly operation: string;
  readonly stepId: string;
  readonly step: Extract<Step, { type: "call" }>;
  readonly background: boolean;
  readonly onClose: () => void;
}) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const [values, setValues] = useState<TunableValues>(step);
  const apply = () => {
    dispatch("updateStep", { operation, stepId, ...paramsUpdate(step.action, values, background) });
    onClose();
  };
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-info-line bg-info-soft p-3"
      data-testid="step-settings"
    >
      <StepParams
        action={step.action}
        values={values}
        onChange={setValues}
        background={background}
      />
      <div className="flex gap-2">
        <Button variant="primary" onClick={apply}>
          Apply
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
