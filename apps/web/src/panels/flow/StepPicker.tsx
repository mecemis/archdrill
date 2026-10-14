import {
  ACTIONS,
  type ActionId,
  type Attempt,
  actionTakesEntity,
  actionTakesParam,
  type CatalogIndex,
  getLogic,
  type LogicId,
  offeredLogic,
  type Step,
  type StepInput,
} from "@archdrill/model";
import { CornerDownRight, GitFork, Reply, Search, Sparkles, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { activePack } from "../../state/content";
import { useUi } from "../../state/ui-store";
import { KindChip } from "../../ui/icons";
import { FOCUS_RING, IconButton, Select } from "../../ui/primitives";
import { successStatus } from "./defaults";
import type { EditContext } from "./flow-edits";
import { commitStep, operationEntity, type PickerMode } from "./pick";
import { stepSentence } from "./sentences";
import { componentLabel } from "./step-label";
import { suggestNext } from "./suggestions";

interface Option {
  readonly key: string;
  readonly label: string;
  readonly step: StepInput;
}

/** Statuses offered after the success ones, in the order people reach for them. */
const COMMON_STATUSES = [400, 404, 409, 429, 503] as const;

function callOptions(
  attempt: Attempt,
  handler: string,
  entity: string,
  catalog: CatalogIndex,
): Map<string, Option[]> {
  const byTarget = new Map<string, Option[]>();
  for (const connection of attempt.architecture.connections) {
    if (connection.from !== handler || connection.mode !== "sync") continue;
    const target = attempt.architecture.components.find((c) => c.id === connection.to);
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
    if (options.length > 0) byTarget.set(target.id, options);
  }
  return byTarget;
}

/** Whether a suggested step does what an existing step does. */
function sameStep(input: StepInput, step: Step | undefined): boolean {
  if (!step || input.type !== step.type) return false;
  if (input.type === "call" && step.type === "call") {
    return input.target === step.target && input.action === step.action;
  }
  return input.type === "logic" && step.type === "logic" && input.logic === step.logic;
}

const matches = (label: string, terms: readonly string[]) =>
  terms.every((t) => label.toLowerCase().includes(t));

/**
 * Chooses the next step: suggestions first, then everything the service can
 * do (its calls, decisions and responses), searchable. Choosing adds the step
 * at once, with its usual exits filled in.
 */
export function StepPicker({
  ctx,
  mode,
  title,
  onClose,
  facts,
}: {
  readonly ctx: EditContext;
  readonly mode: PickerMode;
  readonly title: string;
  readonly onClose?: () => void;
  readonly facts: ReadonlySet<string>;
}) {
  const canvasTarget = useUi((s) => s.canvasTarget);
  const [query, setQuery] = useState("");
  const [entity, setEntity] = useState(() => operationEntity(ctx.flow.operation));
  const search = useRef<HTMLInputElement>(null);
  const { attempt, flow, background, operation } = ctx;

  useEffect(() => {
    search.current?.focus({ preventScroll: true });
  }, []);

  // While choosing, the components the service can call light up on the canvas.
  const atStep = mode.at.kind === "root" ? null : mode.at.stepId;
  const atOutcome = mode.at.kind === "root" ? "" : (mode.at.outcomes[0] ?? "");
  useEffect(() => {
    useUi.getState().armSlot({
      operation: flow.operation,
      attach:
        atStep === null ? { to: "root" } : { to: "outcome", stepId: atStep, outcome: atOutcome },
    });
    return () => useUi.getState().armSlot(null);
  }, [atStep, atOutcome, flow.operation]);

  // Clicking a component on the canvas while choosing narrows the list to it.
  useEffect(() => {
    if (canvasTarget) setQuery(componentLabel(attempt, canvasTarget));
  }, [canvasTarget, attempt]);

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const calls = useMemo(
    () => callOptions(attempt, flow.handler, entity, ctx.catalog),
    [attempt, flow.handler, entity, ctx.catalog],
  );
  const slot =
    mode.at.kind === "root"
      ? { operation: flow.operation, attach: { to: "root" as const } }
      : {
          operation: flow.operation,
          attach: {
            to: "outcome" as const,
            stepId: mode.at.stepId,
            outcome: mode.at.outcomes[0] ?? "",
          },
        };
  const suggested: Option[] = suggestNext({
    attempt,
    flow,
    slot,
    problem: ctx.problem,
    operation,
    catalog: ctx.catalog,
    background,
    defaultEntity: entity,
    facts,
  })
    .filter((s) => mode.kind === "append" || s.step.type !== "respond")
    // Inserting in front of a step, that same step is never the suggestion.
    .filter((s) => mode.kind !== "insert" || !sameStep(s.step, flow.steps[mode.before]))
    .slice(0, 4)
    .map((s) => ({ key: s.key, label: stepSentence(s.step, attempt, background), step: s.step }));
  const decisions: Option[] = offeredLogic(ctx.problem.logic)
    .slice()
    .sort((a: LogicId, b: LogicId) => {
      const relevant = (id: LogicId) => {
        const fact = getLogic(id).decidedBy?.fact;
        return fact === undefined || facts.has(fact) ? 0 : 1;
      };
      return relevant(a) - relevant(b);
    })
    .map((logic) => ({
      key: `logic:${logic}`,
      label: stepSentence({ type: "logic", logic }, attempt),
      step: { type: "logic", logic },
    }));
  const success = background ? [200] : [successStatus(operation, ctx.problem, attempt)];
  const statuses = background
    ? [200, 503]
    : [...new Set([...success, ...operation.successStatuses, ...COMMON_STATUSES])];
  // A request must do something before it answers, and an inserted step carries on.
  const responses: Option[] =
    mode.kind === "insert" || mode.at.kind === "root"
      ? []
      : statuses.map((status) => ({
          key: `respond:${status}`,
          label: stepSentence({ type: "respond", status }, attempt, background),
          step: { type: "respond", status },
        }));

  const choose = (option: Option) => {
    // A failed change keeps the picker, and the canvas lit, for another try.
    if (!commitStep(ctx, mode, option.step)) return;
    useUi.getState().armSlot(null);
    onClose?.();
  };

  const filtered = (options: readonly Option[]) => options.filter((o) => matches(o.label, terms));
  const sections: { key: string; heading: ReactNode; options: Option[] }[] = [
    ...(terms.length === 0 && suggested.length > 0
      ? [
          {
            key: "suggested",
            heading: (
              <>
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> Likely next
              </>
            ),
            options: suggested,
          },
        ]
      : []),
    ...[...calls.entries()].map(([target, options]) => {
      const kind = attempt.architecture.components.find((c) => c.id === target)?.kind ?? "";
      return {
        key: target,
        heading: (
          <>
            <KindChip kind={kind} size="xs" /> {componentLabel(attempt, target)}
          </>
        ),
        options: filtered(options),
      };
    }),
    {
      key: "decide",
      heading: (
        <>
          <GitFork className="h-3.5 w-3.5" aria-hidden="true" /> Decide
        </>
      ),
      options: filtered(decisions),
    },
    {
      key: "respond",
      heading: (
        <>
          <Reply className="h-3.5 w-3.5" aria-hidden="true" /> {background ? "Finish" : "Respond"}
        </>
      ),
      options: filtered(responses),
    },
  ].filter((section) => section.options.length > 0);

  return (
    <section
      aria-label="Choose a step"
      className="flex flex-col gap-2 rounded-xl border border-accent-line bg-elevated p-2.5 shadow-pop"
      data-testid="step-picker"
    >
      <header className="flex items-center gap-2">
        <h4 className="text-[13px] font-semibold text-fg">{title}</h4>
        {onClose && (
          <IconButton className="ml-auto h-7 w-7" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        )}
      </header>
      <div className="flex gap-2">
        <span className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden="true"
          />
          <input
            ref={search}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose?.()}
            placeholder="Search"
            aria-label="Search steps"
            className={`h-8 w-full rounded-lg border border-line bg-surface pr-2 pl-8 text-sm text-fg placeholder:text-fg-faint ${FOCUS_RING}`}
          />
        </span>
        {activePack.problem.entities.length > 1 && (
          <Select
            aria-label="Data the call works on"
            title="Data the call works on"
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className="w-28 shrink-0"
          >
            {activePack.problem.entities.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {calls.size === 0 && terms.length === 0 && (
        <p className="flex gap-1.5 rounded-lg bg-warn-soft px-2.5 py-2 text-xs text-warn-fg">
          <CornerDownRight className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {componentLabel(attempt, flow.handler)} is not connected to anything it could call.
          Connect it to a store or cache on the canvas, then come back.
        </p>
      )}
      <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
        {sections.map((section) => (
          <div key={section.key} className="flex flex-col gap-0.5">
            <p className="flex items-center gap-1.5 px-1 text-[11px] font-semibold text-fg-subtle">
              {section.heading}
            </p>
            {section.options.map((option) => (
              <button
                key={`${section.key}:${option.key}`}
                type="button"
                onClick={() => choose(option)}
                className={`rounded-lg px-2.5 py-1.5 text-left text-[13px] text-fg hover:bg-accent-soft hover:text-accent-fg ${FOCUS_RING}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        ))}
        {sections.length === 0 && (
          <p className="px-1 text-xs text-fg-subtle">Nothing matches "{query}".</p>
        )}
      </div>
      <p className="px-1 text-[11px] text-fg-subtle">
        Tip: click a highlighted component on the canvas to see only its steps.
      </p>
    </section>
  );
}
