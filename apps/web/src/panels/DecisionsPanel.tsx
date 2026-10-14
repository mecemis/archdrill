import type { DecisionPoint } from "@archdrill/model";
import { activePack } from "../state/content";
import { useEvaluation } from "../state/evaluation";
import { useAttemptStore } from "../state/store";
import { useUi } from "../state/ui-store";
import { SectionTitle } from "../ui/primitives";

/** Decisions the workloads read, so the UI can say a choice changes the numbers. */
const simulatedDecisions = new Set(
  activePack.scenarios.flatMap((s) =>
    Object.values(s.workload?.keyspace ?? {}).map((k) => k.lengthDecision),
  ),
);

export function DecisionsPanel() {
  return (
    <div className="flex flex-col gap-5 p-4">
      <p className="text-xs text-fg-subtle">
        Interview trade-offs that a diagram cannot show. Your choices are checked against your flows
        and the requirements.
      </p>
      {activePack.problem.decisionPoints.map((point) => (
        <Decision key={point.id} point={point} />
      ))}
    </div>
  );
}

function Decision({ point }: { readonly point: DecisionPoint }) {
  const chosen = useAttemptStore((s) => s.attempt.decisions[point.id]);
  // A finding about this decision is hovered or pinned.
  const highlighted = useUi((s) => (s.hover ?? s.pinned?.highlight)?.decisions.has(point.id));
  const dispatch = useAttemptStore((s) => s.dispatch);
  const implemented = useImplementedStrategy(point.id);
  const assumed = point.options.find((o) => o.id === point.default);
  return (
    <fieldset
      className={`flex flex-col gap-1.5 rounded-md ${highlighted ? "bg-warn-soft p-2 ring-2 ring-warn" : ""}`}
    >
      <legend className="mb-1">
        <SectionTitle>{point.question}</SectionTitle>
      </legend>
      {point.options.map((option) => (
        <label key={option.id} className="flex items-center gap-2 text-sm text-fg">
          <input
            type="radio"
            name={point.id}
            checked={chosen === option.id}
            onChange={() => dispatch("setDecision", { decision: point.id, option: option.id })}
          />
          {option.label}
        </label>
      ))}
      {chosen === undefined && assumed && (
        <p className="text-xs text-fg-subtle">Assumed: {assumed.label}, until you decide.</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {point.requirements.map((r) => (
          <span key={r} className="rounded bg-info-soft px-1.5 py-0.5 font-medium text-info-fg">
            {r}
          </span>
        ))}
        {simulatedDecisions.has(point.id) && (
          <span className="rounded bg-accent-soft px-1.5 py-0.5 font-medium text-accent-fg">
            affects the simulation
          </span>
        )}
        {chosen !== undefined && (
          <button
            type="button"
            className="ml-auto text-fg-subtle underline hover:text-fg"
            onClick={() => dispatch("setDecision", { decision: point.id, option: null })}
          >
            Clear
          </button>
        )}
      </div>
      {implemented && (
        <p className="text-xs text-fg-muted">
          Your flow implements: <span className="font-medium text-fg">{implemented}</span>
        </p>
      )}
    </fieldset>
  );
}

/** The strategy a recognize-strategy check tied to this decision found in the flows, if any. */
function useImplementedStrategy(decision: string): string | null {
  const { scenarios } = useEvaluation();
  for (const result of scenarios) {
    if (result.status !== "evaluated") continue;
    const check = result.checks.find(
      (c) =>
        c.instance.use === "recognize-strategy" &&
        c.instance.params.decision === decision &&
        c.data?.label,
    );
    if (check?.data?.label) return check.data.label;
  }
  return null;
}
