import {
  type Attempt,
  type Flow,
  feasibleOutcomes,
  liveStepIds,
  type Step,
} from "@archdrill/model";
import { CornerDownRight, Plus, SlidersHorizontal, Trash2, Unlink } from "lucide-react";
import { type ReactNode, useState } from "react";
import { stepNumbers } from "../../canvas/projection";
import { useAttemptStore } from "../../state/store";
import { operationById, runsInBackground } from "../../state/triggers";
import { type Attach, type Slot, useUi } from "../../state/ui-store";
import { OutcomeChip } from "../../ui/outcome";
import { Button } from "../../ui/primitives";
import { AddStepForm } from "./AddStepForm";
import { hasTunableParams, paramsUpdate, StepParams, type TunableValues } from "./StepParams";
import { stepTitle } from "./step-label";

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
      <p className="flex items-center gap-1.5 py-0.5 text-xs text-zinc-500">
        <CornerDownRight className="h-3.5 w-3.5" aria-hidden="true" />
        continues at step {number} ({stepTitle(step, attempt)})
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <StepRow stepId={stepId} step={step} number={number} attachedFrom={attachedFrom} ctx={ctx} />
      {step.type !== "respond" && (
        <ul className="ml-3 flex flex-col gap-1 border-l border-zinc-200 pl-3">
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
            <li key={outcome} className="flex items-center gap-1.5 text-xs text-zinc-500">
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
          ctx.highlighted.has(stepId) ? "bg-amber-100" : isLeaf ? "" : "bg-zinc-50"
        }`}
      >
        {!isLeaf && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-teal-700 px-1 text-[11px] font-semibold text-white">
            {number}
          </span>
        )}
        <span className={isLeaf ? "text-zinc-700" : "font-medium text-zinc-900"}>
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
        <div className="flex flex-col gap-1 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs">
          <p className="font-medium text-rose-900">Remove this step and keep what follows…</p>
          {continuations.map(({ outcome, target }) => (
            <button
              key={outcome}
              type="button"
              onClick={() => remove(outcome)}
              className="self-start rounded px-1.5 py-0.5 text-left text-zinc-800 hover:bg-rose-100"
            >
              …on {outcome}: {target}
            </button>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => remove()}
              className="rounded px-1.5 py-0.5 font-medium text-rose-800 hover:bg-rose-100"
            >
              Remove it and everything after it
            </button>
            <button
              type="button"
              onClick={() => setChoosing(false)}
              className="rounded px-1.5 py-0.5 text-zinc-700 hover:bg-zinc-100"
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

function SlotControl({ slot, flow, label }: { slot: Slot; flow: Flow; label: string }) {
  const armed = useUi((s) => s.slot);
  const isArmed =
    armed !== null &&
    armed.before === undefined &&
    armed.operation === slot.operation &&
    JSON.stringify(armed.attach) === JSON.stringify(slot.attach);
  if (isArmed) return <AddStepForm slot={slot} flow={flow} />;
  return (
    <button
      type="button"
      onClick={() => useUi.getState().armSlot(slot)}
      className="flex items-center gap-1 self-start rounded-md border border-dashed border-amber-400 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50"
    >
      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
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
    <div className="mt-3 flex flex-col gap-1 rounded-md bg-zinc-50 p-2">
      <p className="text-xs font-medium text-zinc-600">Not reachable from the first step</p>
      {orphans.map((id) => {
        const step = flow.steps[id];
        return step ? (
          <div key={id} className="flex items-center gap-2 text-xs text-zinc-700">
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
      className="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900"
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
      className="flex flex-col gap-3 rounded-md border border-sky-300 bg-sky-50 p-3"
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
