import type { Readiness, ScenarioResult } from "@archdrill/evaluator";
import { ListChecks } from "lucide-react";
import { activePack } from "../../state/content";
import { useEvaluationPending } from "../../state/evaluation";
import { useOnboarding } from "../../state/onboarding";
import { Badge, Button } from "../../ui/primitives";

type Band = "not-passing" | "passing" | "strong" | "excellent";

const BAND_STYLES: Readonly<
  Record<Band, { readonly label: string; readonly tone: "bad" | "warn" | "info" | "ok" }>
> = {
  "not-passing": { label: "Not passing", tone: "bad" },
  passing: { label: "Passing", tone: "warn" },
  strong: { label: "Strong", tone: "info" },
  excellent: { label: "Excellent", tone: "ok" },
};

/** Stroke colours for the score ring, by band. */
const RING_COLORS: Readonly<Record<Band, string>> = {
  "not-passing": "var(--bad)",
  passing: "var(--warn)",
  strong: "var(--info)",
  excellent: "var(--ok)",
};

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

/** Bar colour for a dimension score. */
function dimensionTone(score: number): string {
  if (score >= 90) return "bg-ok";
  if (score >= 70) return "bg-info";
  if (score >= 50) return "bg-warn";
  return "bg-bad";
}

const RING_RADIUS = 26;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function ScoreRing({ score, band }: { readonly score: number; readonly band: Band }) {
  return (
    <div className="relative h-16 w-16 shrink-0" data-tour="score">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90" aria-hidden="true">
        <circle cx="32" cy="32" r={RING_RADIUS} fill="none" stroke="var(--track)" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={RING_RADIUS}
          fill="none"
          stroke={RING_COLORS[band]}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${(RING_LENGTH * score) / 100} ${RING_LENGTH}`}
          className="transition-[stroke-dasharray] duration-500"
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center text-xl font-bold text-fg tabular-nums"
        data-testid="scenario-score"
      >
        {score}
      </span>
    </div>
  );
}

/** The score and band in one line, for the results drawer's header. */
export function ScoreChip({ result }: { readonly result: ScenarioResult | undefined }) {
  if (!result) return null;
  if (result.status !== "evaluated") {
    return (
      <Badge tone={result.status === "invalid" ? "bad" : "neutral"}>
        {result.status === "invalid" ? "Not evaluable" : "Waiting for flows"}
      </Badge>
    );
  }
  const band = BAND_STYLES[result.scorecard.band];
  return (
    <span className="flex items-center gap-2">
      <span className="text-base font-bold text-fg tabular-nums">{result.scorecard.score}</span>
      <Badge tone={band.tone}>{band.label}</Badge>
    </span>
  );
}

export function ScoreSummary({ result }: { readonly result: ScenarioResult | undefined }) {
  const pending = useEvaluationPending();
  const guideOpen = useOnboarding((s) => s.guideOpen);
  if (!result) return null;
  if (result.status === "invalid") {
    return (
      <div className="flex flex-col gap-1 p-4">
        <p className="text-sm font-semibold text-bad-fg">Not evaluable yet</p>
        <p className="text-sm text-fg-muted">
          Fix {result.blocking.length} design error{result.blocking.length === 1 ? "" : "s"} (see
          Issues) to get a score.
        </p>
      </div>
    );
  }
  if (result.status === "incomplete") {
    return (
      <div className="flex flex-col gap-2 p-4">
        <p className="text-sm font-semibold text-fg">Waiting for flows</p>
        <p className="text-xs text-fg-subtle">
          The score appears once every operation below has a flow whose branches all end with a
          response.
        </p>
        <ul className="flex flex-col gap-1">
          {result.operations.map(({ operation, status }) => {
            const op = activePack.problem.operations.find((o) => o.id === operation);
            return (
              <li key={operation} className="flex items-center gap-2 text-sm text-fg-muted">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true" />
                {op?.label ?? operation}: {READINESS_LABELS[status]}
              </li>
            );
          })}
        </ul>
        {!guideOpen && (
          <Button
            size="sm"
            className="self-start"
            onClick={() => useOnboarding.getState().setGuideOpen(true)}
          >
            <ListChecks className="h-3.5 w-3.5" />
            Guide me
          </Button>
        )}
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
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <ScoreRing score={scorecard.score} band={scorecard.band} />
        <div className="flex min-w-0 flex-col items-start gap-1">
          <Badge tone={band.tone} className="text-xs">
            {band.label}
          </Badge>
          {scorecard.cap && (
            <p className="text-xs text-fg-subtle">
              Capped at {scorecard.cap.value} by {CAP_REASONS[scorecard.cap.reason]}.
            </p>
          )}
          <span className="text-xs text-fg-subtle" aria-live="polite">
            {pending ? "Updating…" : ""}
          </span>
        </div>
      </div>
      {strategies.map(({ id, label }) => (
        <p key={id} className="text-xs text-fg-subtle">
          Approach: <span className="font-semibold text-fg">{label}</span>
        </p>
      ))}
      <ul className="flex flex-col gap-2">
        {scorecard.dimensions.map((d) => (
          <li key={d.dimension} className="flex flex-col gap-1 text-xs">
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-fg-muted">{titleCase(d.dimension)}</span>
              {d.score !== null && (
                <span className="font-medium text-fg tabular-nums">{Math.round(d.score)}</span>
              )}
            </span>
            {d.score === null ? (
              <span className="text-fg-subtle">
                {d.definedCount > 0 ? "not applicable to this design" : "not evaluated yet"}
              </span>
            ) : (
              <span className="h-1.5 overflow-hidden rounded-full bg-track" aria-hidden="true">
                <span
                  className={`block h-full rounded-full transition-[width] duration-500 ${dimensionTone(d.score)}`}
                  style={{ width: `${d.score}%` }}
                />
              </span>
            )}
          </li>
        ))}
      </ul>
      {(scorecard.signals.senior.total > 0 || scorecard.signals.staff.total > 0) && (
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={signalTone(scorecard.signals.senior)}>
            Senior {scorecard.signals.senior.demonstrated}/{scorecard.signals.senior.total}
          </Badge>
          {scorecard.signals.staff.total > 0 && (
            <Badge tone={signalTone(scorecard.signals.staff)}>
              Staff {scorecard.signals.staff.demonstrated}/{scorecard.signals.staff.total}
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

function signalTone(signal: { readonly demonstrated: number; readonly total: number }) {
  if (signal.total === 0) return "neutral" as const;
  return signal.demonstrated === signal.total ? ("accent" as const) : ("neutral" as const);
}
