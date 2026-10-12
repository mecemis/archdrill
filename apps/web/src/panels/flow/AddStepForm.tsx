import {
  ACTIONS,
  type ActionId,
  type Attempt,
  type Flow,
  LOGIC,
  type LogicId,
  type StepInput,
} from "@archdrill/model";
import { useEffect, useMemo, useState } from "react";
import { activePack, catalogIndex } from "../../state/content";
import { useAttemptStore } from "../../state/store";
import { type Slot, useUi } from "../../state/ui-store";
import { COMMON_STATUSES, statusLabel } from "../../ui/outcome";
import { Button, Field, Select } from "../../ui/primitives";
import { componentLabel, stepTitle } from "./step-label";

type Mode = "call" | "logic" | "respond" | "goto";

const DEFAULT_TTL: Partial<Record<ActionId, number>> = {
  "cache.set": 3600,
  "cache.setNegative": 60,
};

function callableTargets(attempt: Attempt, flow: Flow): string[] {
  return attempt.architecture.connections
    .filter((c) => c.from === flow.handler && c.mode === "sync")
    .map((c) => c.to);
}

function actionsFor(attempt: Attempt, targetId: string): ActionId[] {
  const target = attempt.architecture.components.find((c) => c.id === targetId);
  if (!target) return [];
  const caps = catalogIndex.capabilities(target.kind, target.flavor);
  return (Object.keys(ACTIONS) as ActionId[]).filter((id) => caps.has(ACTIONS[id].capability));
}

/** Inline form that fills one outcome slot (or inserts in front of a step). */
export function AddStepForm({ slot, flow }: { readonly slot: Slot; readonly flow: Flow }) {
  const attempt = useAttemptStore((s) => s.attempt);
  const dispatch = useAttemptStore((s) => s.dispatch);
  const canvasTarget = useUi((s) => s.canvasTarget);
  const targets = useMemo(() => callableTargets(attempt, flow), [attempt, flow]);
  const [mode, setMode] = useState<Mode>(targets.length > 0 ? "call" : "respond");
  const [target, setTarget] = useState(targets[0] ?? "");
  const actions = useMemo(() => actionsFor(attempt, target), [attempt, target]);
  const [action, setAction] = useState<ActionId | "">(actions[0] ?? "");
  const [entity, setEntity] = useState(activePack.problem.entities[0]?.name ?? "");
  const [ttl, setTtl] = useState(3600);
  const [logic, setLogic] = useState<LogicId>("checkExpiry");
  const [status, setStatus] = useState(302);
  const [gotoStep, setGotoStep] = useState("");
  const [continueWith, setContinueWith] = useState("");

  useEffect(() => {
    if (canvasTarget && targets.includes(canvasTarget)) {
      setMode("call");
      setTarget(canvasTarget);
    }
  }, [canvasTarget, targets]);
  useEffect(() => {
    if (!actions.includes(action as ActionId)) setAction(actions[0] ?? "");
  }, [actions, action]);
  useEffect(() => {
    if (action) setTtl(DEFAULT_TTL[action] ?? 3600);
  }, [action]);

  const inserting = slot.before !== undefined;
  const draft = buildStep(mode, { target, action, entity, ttl, logic, status });
  const outcomes = useMemo(() => draftOutcomes(draft), [draft]);
  useEffect(() => {
    if (inserting && !outcomes.includes(continueWith)) setContinueWith(outcomes[0] ?? "");
  }, [inserting, outcomes, continueWith]);

  const submit = () => {
    if (mode === "goto") {
      if (slot.attach.to === "outcome" && gotoStep) {
        dispatch("linkOutcome", {
          operation: slot.operation,
          stepId: slot.attach.stepId,
          outcome: slot.attach.outcome,
          target: gotoStep,
        });
      }
    } else if (draft) {
      dispatch("addStep", {
        operation: slot.operation,
        step: draft,
        attach: slot.attach,
        ...(inserting && continueWith ? { continueWith: { outcome: continueWith } } : {}),
      });
    }
    useUi.getState().armSlot(null);
  };

  const modes: { id: Mode; label: string; disabled?: boolean }[] = [
    { id: "call", label: "Call", disabled: targets.length === 0 },
    { id: "logic", label: "Logic" },
    { id: "respond", label: "Respond", disabled: inserting },
    { id: "goto", label: "Go to step", disabled: inserting || slot.attach.to === "root" },
  ];
  const existing = Object.entries(flow.steps).filter(([, s]) => s.type !== "respond");

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-sky-300 bg-sky-50 p-3"
      data-testid="add-step-form"
    >
      <fieldset className="flex flex-wrap gap-1">
        <legend className="sr-only">Step type</legend>
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={mode === m.id}
            disabled={m.disabled}
            onClick={() => setMode(m.id)}
            className={`rounded px-2 py-1 text-xs font-medium disabled:opacity-40 ${mode === m.id ? "bg-sky-700 text-white" : "bg-white text-zinc-700"}`}
          >
            {m.label}
          </button>
        ))}
      </fieldset>
      {mode === "call" && (
        <>
          <p className="text-xs text-zinc-600">
            Tip: click a highlighted component on the canvas to pick it.
          </p>
          <Field label="Component">
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((id) => (
                <option key={id} value={id}>
                  {componentLabel(attempt, id)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Action">
            <Select value={action} onChange={(e) => setAction(e.target.value as ActionId)}>
              {actions.map((id) => (
                <option key={id} value={id} title={ACTIONS[id].description}>
                  {ACTIONS[id].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Entity">
            <Select value={entity} onChange={(e) => setEntity(e.target.value)}>
              {activePack.problem.entities.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
          {action && (ACTIONS[action].params as readonly string[]).includes("ttlSec") && (
            <Field label="TTL (seconds)">
              <input
                type="number"
                min={1}
                value={ttl}
                onChange={(e) => setTtl(Math.max(1, Number(e.target.value)))}
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
              />
            </Field>
          )}
        </>
      )}
      {mode === "logic" && (
        <Field label="Decision">
          <Select value={logic} onChange={(e) => setLogic(e.target.value as LogicId)}>
            {(Object.keys(LOGIC) as LogicId[]).map((id) => (
              <option key={id} value={id}>
                {LOGIC[id].label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {mode === "respond" && (
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(Number(e.target.value))}>
            {COMMON_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {mode === "goto" && (
        <Field label="Continue at">
          <Select value={gotoStep} onChange={(e) => setGotoStep(e.target.value)}>
            <option value="">Choose a step…</option>
            {existing.map(([id, s]) => (
              <option key={id} value={id}>
                {stepTitle(s, attempt)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {inserting && outcomes.length > 0 && (
        <Field label="Then continue with the existing step on">
          <Select value={continueWith} onChange={(e) => setContinueWith(e.target.value)}>
            {outcomes.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="flex gap-2">
        <Button variant="primary" onClick={submit} disabled={mode === "goto" ? !gotoStep : !draft}>
          {inserting ? "Insert step" : "Add step"}
        </Button>
        <Button variant="ghost" onClick={() => useUi.getState().armSlot(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function buildStep(
  mode: Mode,
  v: {
    target: string;
    action: ActionId | "";
    entity: string;
    ttl: number;
    logic: LogicId;
    status: number;
  },
): StepInput | null {
  if (mode === "call") {
    if (!v.target || !v.action) return null;
    const needsTtl = (ACTIONS[v.action].params as readonly string[]).includes("ttlSec");
    return {
      type: "call",
      target: v.target,
      action: v.action,
      entity: v.entity,
      ...(needsTtl ? { ttlSec: v.ttl } : {}),
    };
  }
  if (mode === "logic") return { type: "logic", logic: v.logic };
  if (mode === "respond") return { type: "respond", status: v.status };
  return null;
}

function draftOutcomes(draft: StepInput | null): readonly string[] {
  if (draft?.type === "call") return ACTIONS[draft.action].outcomes;
  if (draft?.type === "logic") return LOGIC[draft.logic].outcomes;
  return [];
}
