import type { DecisionPoint } from "@archdrill/model";
import { activePack } from "../state/content";
import { useEvaluation } from "../state/evaluation";
import { useAttemptStore } from "../state/store";
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
      <p className="text-xs text-zinc-500">
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
  const dispatch = useAttemptStore((s) => s.dispatch);
  const implemented = useImplementedStrategy(point.id);
  const effective = chosen ?? point.default;
  const assumed = point.options.find((o) => o.id === point.default);
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1">
        <SectionTitle>{point.question}</SectionTitle>
      </legend>
      {point.options.map((option) => (
        <label key={option.id} className="flex items-center gap-2 text-sm text-zinc-800">
          <input
            type="radio"
            name={point.id}
            checked={effective === option.id}
            onChange={() => dispatch("setDecision", { decision: point.id, option: option.id })}
          />
          {option.label}
        </label>
      ))}
      {chosen === undefined && assumed && (
        <p className="text-xs text-zinc-500">Assumed: {assumed.label}, until you decide.</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {point.requirements.map((r) => (
          <span key={r} className="rounded bg-sky-50 px-1.5 py-0.5 font-medium text-sky-800">
            {r}
          </span>
        ))}
        {simulatedDecisions.has(point.id) && (
          <span className="rounded bg-violet-50 px-1.5 py-0.5 font-medium text-violet-800">
            affects the simulation
          </span>
        )}
        {chosen !== undefined && (
          <button
            type="button"
            className="ml-auto text-zinc-500 underline hover:text-zinc-800"
            onClick={() => dispatch("setDecision", { decision: point.id, option: null })}
          >
            Clear
          </button>
        )}
      </div>
      {implemented && (
        <p className="text-xs text-zinc-600">
          Your flow implements: <span className="font-medium text-zinc-900">{implemented}</span>
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
