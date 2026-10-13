import type { Readiness, ScenarioResult } from "@archdrill/evaluator";
import { activePack } from "../../state/content";
import { useEvaluationPending } from "../../state/evaluation";

const BAND_STYLES = {
  "not-passing": { label: "Not passing", className: "bg-rose-100 text-rose-800" },
  passing: { label: "Passing", className: "bg-amber-100 text-amber-900" },
  strong: { label: "Strong", className: "bg-sky-100 text-sky-900" },
  excellent: { label: "Excellent", className: "bg-emerald-100 text-emerald-900" },
} as const;

const READINESS_LABELS: Readonly<Record<Readiness, string>> = {
  missing: "no flow yet",
  empty: "no steps yet",
  broken: "flow has errors",
  ready: "ready",
  "too-complex": "too many paths to evaluate; simplify the branching",
};

const CAP_REASONS = {
  gate: "a gate failed",
  critical: "an open critical finding",
  major: "an open major finding",
} as const;

function titleCase(id: string): string {
  return id.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function ScoreSummary({ result }: { readonly result: ScenarioResult | undefined }) {
  const pending = useEvaluationPending();
  if (!result) return null;
  if (result.status === "invalid") {
    return (
      <div className="flex flex-col gap-1 p-4">
        <p className="text-sm font-semibold text-rose-800">Not evaluable yet</p>
        <p className="text-sm text-zinc-600">
          Fix {result.blocking.length} design error{result.blocking.length === 1 ? "" : "s"} (see
          Issues) to get a score.
        </p>
      </div>
    );
  }
  if (result.status === "incomplete") {
    return (
      <div className="flex flex-col gap-1 p-4">
        <p className="text-sm font-semibold text-zinc-900">Waiting for flows</p>
        {result.operations.map(({ operation, status }) => {
          const op = activePack.problem.operations.find((o) => o.id === operation);
          return (
            <p key={operation} className="text-sm text-zinc-600">
              {op?.label ?? operation}: {READINESS_LABELS[status]}
            </p>
          );
        })}
      </div>
    );
  }
  const { scorecard } = result;
  const band = BAND_STYLES[scorecard.band];
  const strategies = result.checks.flatMap((c) =>
    c.instance.use === "recognize-strategy" && c.data?.label
      ? [{ id: c.instance.id, label: c.data.label }]
      : [],
  );
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline gap-3">
        <span
          className="text-4xl font-bold tabular-nums text-zinc-900"
          data-testid="scenario-score"
        >
          {scorecard.score}
        </span>
        <span className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${band.className}`}>
          {band.label}
        </span>
        <span className="text-xs text-zinc-500" aria-live="polite">
          {pending ? "Updating…" : ""}
        </span>
      </div>
      {scorecard.cap && (
        <p className="text-xs text-zinc-600">
          Capped at {scorecard.cap.value} by {CAP_REASONS[scorecard.cap.reason]}.
        </p>
      )}
      {strategies.map(({ id, label }) => (
        <p key={id} className="text-xs text-zinc-700">
          Approach: <span className="font-semibold text-zinc-900">{label}</span>
        </p>
      ))}
      <ul className="flex flex-col gap-1.5">
        {scorecard.dimensions.map((d) => (
          <li
            key={d.dimension}
            className="grid grid-cols-[7rem_1fr_2.5rem] items-center gap-2 text-xs"
          >
            <span className="text-zinc-700">{titleCase(d.dimension)}</span>
            {d.score === null ? (
              <span className="col-span-2 text-zinc-400">
                {d.definedCount > 0 ? "not applicable to this design" : "not evaluated yet"}
              </span>
            ) : (
              <>
                <span className="h-2 overflow-hidden rounded-full bg-zinc-200" aria-hidden="true">
                  <span
                    className="block h-full rounded-full bg-teal-600"
                    style={{ width: `${d.score}%` }}
                  />
                </span>
                <span className="text-right tabular-nums text-zinc-800">{Math.round(d.score)}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      {(scorecard.signals.senior.total > 0 || scorecard.signals.staff.total > 0) && (
        <p className="text-xs text-zinc-600">
          Signals: senior {scorecard.signals.senior.demonstrated}/{scorecard.signals.senior.total}
          {scorecard.signals.staff.total > 0 &&
            ` · staff ${scorecard.signals.staff.demonstrated}/${scorecard.signals.staff.total}`}
        </p>
      )}
    </div>
  );
}
