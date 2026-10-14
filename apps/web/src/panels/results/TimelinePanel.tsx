import { describePath, type TimelineMark, type TimelineMetrics } from "@archdrill/engine";
import type { Prediction } from "@archdrill/model";
import { CircleCheck, CircleX, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { activePack } from "../../state/content";
import { useEvaluation } from "../../state/evaluation";
import { currentAnswers, predictionKey, usePredictions } from "../../state/predictions";
import { useAttemptStore } from "../../state/store";
import { useGated, useScenarioTimelines, useShownTimeline } from "../../state/timeline-view";
import { useUi } from "../../state/ui-store";
import { compact, milliseconds, percent } from "../../ui/format";
import { LineChart, type TimeBand } from "../../ui/LineChart";
import { StatusBadge } from "../../ui/outcome";
import { Button, IconButton, Tabs } from "../../ui/primitives";
import { componentLabel } from "../flow/step-label";

/** Components worth charting: those that come anywhere near capacity. */
const UTILIZATION_SHOWN = 0.3;
const MAX_COMPONENTS = 5;
/** Paths listed for a moment; the rest are summed up. */
const MAX_PATHS = 8;

/** How the design behaves over time in the scenario's timelines. */
export function TimelinePanel() {
  const timelines = useScenarioTimelines();
  const metrics = useShownTimeline();
  if (!metrics) {
    return (
      <p className="p-3 text-sm text-fg-subtle">
        Timelines appear once the scenario can be evaluated.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4 p-3">
      {timelines.length > 1 && (
        <Tabs
          label="Timeline"
          value={metrics.timeline.id}
          onChange={(id) => useUi.getState().setTimelineId(id)}
          options={timelines.map((t) => ({ id: t.timeline.id, label: t.timeline.label }))}
        />
      )}
      {metrics.timeline.description && (
        <p className="text-sm text-fg-muted">{metrics.timeline.description}</p>
      )}
      <TimelineView metrics={metrics} />
    </div>
  );
}

function TimelineView({ metrics }: { readonly metrics: TimelineMetrics }) {
  const scenarioId = useUi((s) => s.scenarioId);
  const key = predictionKey(scenarioId, metrics.timeline.id);
  const gated = useGated(metrics);
  const questions = metrics.timeline.predictions;
  if (gated) return <PredictGate predictionsKey={key} questions={questions} />;
  return (
    <>
      {questions.length > 0 && <PredictionResults predictionsKey={key} metrics={metrics} />}
      <Scrubber metrics={metrics} />
      <TimelineCharts metrics={metrics} />
      <PathMix metrics={metrics} />
      <EventLog metrics={metrics} />
    </>
  );
}

const NO_ANSWERS: Readonly<Record<string, string>> = {};

/** Before a timeline is revealed: what does the candidate expect to happen? */
function PredictGate({
  predictionsKey,
  questions,
}: {
  readonly predictionsKey: string;
  readonly questions: readonly Prediction[];
}) {
  const stored = usePredictions((s) => s.byTimeline[predictionsKey]?.answers ?? NO_ANSWERS);
  const answers = currentAnswers(stored, questions);
  const { answer, reveal } = usePredictions.getState();
  const complete = questions.every((q) => answers[q.id] !== undefined);
  return (
    <section
      aria-label="Predict, then reveal"
      className="flex flex-col gap-4 rounded-md border border-accent-line bg-accent-soft p-4"
    >
      <p className="text-sm text-accent-fg">
        Before you look: what do you expect to happen? Your answers are shown next to what the
        simulation finds.
      </p>
      {questions.map((q) => (
        <fieldset key={q.id} className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium text-fg">{q.question}</legend>
          {q.options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm text-fg">
              <input
                type="radio"
                name={`${predictionsKey}/${q.id}`}
                checked={answers[q.id] === o.id}
                onChange={() => answer(predictionsKey, q.id, o.id)}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
      ))}
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={!complete} onClick={() => reveal(predictionsKey)}>
          Reveal the timeline
        </Button>
        <button
          type="button"
          className="text-sm text-fg-muted underline hover:text-fg"
          onClick={() => reveal(predictionsKey)}
        >
          Skip and show it
        </button>
      </div>
    </section>
  );
}

function describeValue(prediction: Prediction, value: number): string {
  switch (prediction.measure.kind) {
    case "peak-utilization":
      return `peaks at ${percent(value, 0)}`;
    case "lowest-success":
      return `lowest ${percent(value, value > 0.999 && value < 1 ? 2 : 1)}`;
    case "recovery-seconds":
      return Number.isFinite(value) ? `${Math.round(value)} s` : "not back by the end";
  }
}

/** What the candidate predicted, next to what happened. */
function PredictionResults({
  predictionsKey,
  metrics,
}: {
  readonly predictionsKey: string;
  readonly metrics: TimelineMetrics;
}) {
  const stored = usePredictions((s) => s.byTimeline[predictionsKey]?.answers ?? NO_ANSWERS);
  const answers = currentAnswers(stored, metrics.timeline.predictions);
  const answered = metrics.timeline.predictions.filter((q) => answers[q.id] !== undefined);
  return (
    <section aria-label="Your predictions" className="flex flex-col gap-2">
      {answered.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {answered.map((q) => {
            const actual = metrics.predictions.get(q.id);
            const label = (id: string | undefined) => q.options.find((o) => o.id === id)?.label;
            const right = actual?.optionId === answers[q.id];
            const Icon = right ? CircleCheck : CircleX;
            return (
              <li key={q.id} className="flex gap-2 text-sm">
                <Icon
                  className={`mt-0.5 h-4 w-4 shrink-0 ${right ? "text-ok-fg" : "text-bad-fg"}`}
                  aria-label={right ? "Right" : "Not quite"}
                />
                <span>
                  <span className="font-medium text-fg">{q.question}</span>{" "}
                  <span className="text-fg-muted">
                    You said: {label(answers[q.id])}. It was: {label(actual?.optionId)}
                    {actual ? ` (${describeValue(q, actual.value)})` : ""}.
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        className="self-start text-xs text-fg-muted underline hover:text-fg"
        onClick={() => {
          usePredictions.getState().reset(predictionsKey);
          // The canvas would otherwise give the moment away while the questions are up.
          useUi.getState().setTimelineCursor(null);
        }}
      >
        Predict again
      </button>
    </section>
  );
}

function useCursorStep(metrics: TimelineMetrics): number | null {
  const cursor = useUi((s) => s.timelineCursor);
  return cursor && cursor.timelineId === metrics.timeline.id ? cursor.step : null;
}

function stepAt(metrics: TimelineMetrics, t: number): number {
  return metrics.times.reduce(
    (best, time, i) => (Math.abs(time - t) < Math.abs((metrics.times[best] ?? 0) - t) ? i : best),
    0,
  );
}

/** A whole timeline plays in about this long, however many steps it has. */
const PLAYBACK_MS = 9000;
/** No faster than this per step, so short timelines stay watchable. */
const MIN_STEP_MS = 120;

/** Plays the timeline: moves the moment forward step by step, and stops at the end. */
function usePlayback(metrics: TimelineMetrics, step: number | null) {
  const [playing, setPlaying] = useState(false);
  const last = metrics.times.length - 1;
  useEffect(() => {
    if (!playing) return;
    const interval = Math.max(MIN_STEP_MS, PLAYBACK_MS / Math.max(1, last));
    const timer = setInterval(() => {
      const ui = useUi.getState();
      const current =
        ui.timelineCursor?.timelineId === metrics.timeline.id ? ui.timelineCursor.step : -1;
      if (current >= last) {
        setPlaying(false);
        return;
      }
      ui.setTimelineCursor({ timelineId: metrics.timeline.id, step: current + 1 });
    }, interval);
    return () => clearInterval(timer);
  }, [playing, last, metrics.timeline.id]);
  const toggle = () => {
    // Playing from the end starts over.
    if (!playing && step === last) {
      useUi.getState().setTimelineCursor({ timelineId: metrics.timeline.id, step: 0 });
    }
    setPlaying(!playing);
  };
  return { playing, toggle, stop: () => setPlaying(false) };
}

/** Picks the moment the canvas and the path mix show. */
function Scrubber({ metrics }: { readonly metrics: TimelineMetrics }) {
  const step = useCursorStep(metrics);
  const { playing, toggle, stop } = usePlayback(metrics, step);
  const set = (next: number | null) => {
    stop();
    useUi
      .getState()
      .setTimelineCursor(next === null ? null : { timelineId: metrics.timeline.id, step: next });
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <IconButton
        onClick={toggle}
        aria-label={playing ? "Pause the timeline" : "Play the timeline"}
        title={playing ? "Pause" : "Play: watch the design change over time on the canvas"}
        active={playing}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </IconButton>
      <label className="flex flex-1 items-center gap-2 text-sm text-fg-muted">
        <span className="shrink-0">Moment</span>
        <input
          type="range"
          className="min-w-40 flex-1"
          min={0}
          max={metrics.times.length - 1}
          value={step ?? 0}
          aria-valuetext={step === null ? "none" : `${metrics.times[step]} seconds`}
          onChange={(e) => set(Number(e.target.value))}
          // With no moment picked the thumb rests at the start, where a change never fires.
          onPointerDown={() => step === null && set(0)}
          onKeyDown={() => step === null && set(0)}
        />
        <span className="w-16 tabular-nums">
          {step === null ? "—" : `${metrics.times[step]} s`}
        </span>
      </label>
      {step === null ? (
        <span className="text-xs text-fg-subtle">
          Pick a moment to see the design at that time; click a chart to jump there.
        </span>
      ) : (
        <button
          type="button"
          className="text-xs text-fg-muted underline hover:text-fg"
          onClick={() => set(null)}
        >
          Clear
        </button>
      )}
    </div>
  );
}

/** Fault windows, from each fault's start to its end (or the end of the timeline). */
function faultBands(metrics: TimelineMetrics): TimeBand[] {
  return metrics.marks
    .filter((m) => m.kind === "fault-start")
    .map((start) => {
      const end = metrics.marks.find(
        (m) => m.kind === "fault-end" && m.label === start.label && m.at >= start.at,
      );
      return { from: start.at, to: end?.at ?? metrics.timeline.durationSec, label: start.label };
    });
}

const operationLabel = (id: string) =>
  activePack.problem.operations.find((o) => o.id === id)?.label ?? id;

function TimelineCharts({ metrics }: { readonly metrics: TimelineMetrics }) {
  const attempt = useAttemptStore((s) => s.attempt);
  const step = useCursorStep(metrics);
  const cursor = step === null ? undefined : metrics.times[step];
  const onPick = (t: number) =>
    useUi
      .getState()
      .setTimelineCursor({ timelineId: metrics.timeline.id, step: stepAt(metrics, t) });
  const common = { times: metrics.times, bands: faultBands(metrics), cursor, onPick };
  const operations = [...metrics.operations].filter(([, s]) => s.rate.some((r) => r > 0));
  const judged = (values: readonly number[], rate: readonly number[]) =>
    values.map((v, i) => ((rate[i] ?? 0) > 0 ? v : null));
  const successes = operations.map(([id, s]) => ({
    label: operationLabel(id),
    values: judged(s.successRate, s.rate),
  }));
  const lowest = Math.min(
    0.99,
    ...successes.flatMap((s) => s.values.filter((v): v is number => v !== null)),
  );
  const latencies = operations.map(([id, s]) => ({
    label: operationLabel(id),
    values: judged(s.p99, s.rate),
  }));
  const slowest = Math.max(
    1,
    ...latencies.flatMap((s) => s.values.filter((v): v is number => v !== null)),
  );
  const busy = [...metrics.components]
    .map(([id, s]) => ({ id, series: s, peak: Math.max(...s.utilization) }))
    .filter((c) => c.peak > UTILIZATION_SHOWN)
    .sort((a, b) => b.peak - a.peak)
    .slice(0, MAX_COMPONENTS);
  const busiest = Math.max(1.1, ...busy.map((c) => c.peak));
  const scaled = [...metrics.components].filter(([, s]) => new Set(s.instances).size > 1);
  const caches = [...metrics.caches].map(([key, values]) => {
    const [component, entity] = key.split("|");
    return { label: `${componentLabel(attempt, component ?? "")} · ${entity ?? ""}`, values };
  });
  const backlogs = operations.filter(([, s]) => s.backlog.some((b) => b > 0));

  return (
    <>
      {metrics.unsettledSteps > 0 && (
        <p className="rounded-md bg-warn-soft px-2.5 py-2 text-xs text-warn-fg">
          The load model did not settle in {metrics.unsettledSteps} steps; those numbers are
          approximate.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <LineChart
          title="Success rate"
          series={successes}
          domain={[lowest, 1]}
          format={(v) => percent(v, v > 0.999 && v < 1 ? 2 : 1)}
          {...common}
        />
        <LineChart
          title="p99 latency of successful requests"
          series={latencies}
          domain={[0, slowest * 1.1]}
          format={milliseconds}
          {...common}
        />
        {busy.length > 0 && (
          <LineChart
            title="Utilisation (the busiest part of each component)"
            series={busy.map((c) => ({
              label: componentLabel(attempt, c.id),
              values: c.series.utilization,
            }))}
            domain={[0, busiest]}
            format={(v) => percent(v, 0)}
            limit={{ value: 1, label: "capacity" }}
            {...common}
          />
        )}
        {scaled.length > 0 && (
          <LineChart
            title="Running instances"
            series={scaled.map(([id, series]) => ({
              label: componentLabel(attempt, id),
              values: series.instances,
            }))}
            domain={[0, Math.max(1, ...scaled.flatMap(([, s]) => s.instances)) * 1.1]}
            format={(v) => String(Math.round(v))}
            {...common}
          />
        )}
        {caches.length > 0 && (
          <LineChart
            title="Cache hit ratio"
            series={caches}
            domain={[0, 1]}
            format={(v) => percent(v, 0)}
            {...common}
          />
        )}
        {backlogs.length > 0 && (
          <LineChart
            title="Backlog (items waiting)"
            series={backlogs.map(([id, s]) => ({ label: operationLabel(id), values: s.backlog }))}
            domain={[0, Math.max(1, ...backlogs.flatMap(([, s]) => s.backlog))]}
            format={compact}
            {...common}
          />
        )}
      </div>
    </>
  );
}

/** How requests went at the picked moment: each path's share, outcomes and timings. */
function PathMix({ metrics }: { readonly metrics: TimelineMetrics }) {
  const step = useCursorStep(metrics);
  const attempt = useAttemptStore((s) => s.attempt);
  const { analysis } = useEvaluation();
  const scenarioId = useUi((s) => s.scenarioId);
  const [chosen, setChosen] = useState<string | null>(null);
  const focus = activePack.scenarios.find((s) => s.id === scenarioId)?.focusOperations ?? [];
  const available = [...metrics.paths.keys()].sort(
    (a, b) => Number(!focus.includes(a)) - Number(!focus.includes(b)),
  );
  const operation = chosen && available.includes(chosen) ? chosen : available[0];
  if (step === null || !operation) return null;
  const shares = metrics.paths.get(operation)?.[step] ?? [];
  const analysed = analysis.operations.get(operation);
  const reached = shares.reduce((sum, p) => sum + p.share, 0);
  const at = metrics.times[step] ?? 0;
  return (
    <section aria-label="Requests at this moment" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-semibold text-fg-muted">Requests at {at} s</h4>
        <Tabs
          label="Operation"
          value={operation}
          onChange={setChosen}
          options={available.map((id) => ({ id, label: operationLabel(id) }))}
        />
      </div>
      {shares.length === 0 ? (
        <p className="text-sm text-fg-subtle">Nothing reaches {operationLabel(operation)} now.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {shares.slice(0, MAX_PATHS).map((share) => {
            const path = analysed?.paths.find((p) => p.id === share.pathId);
            if (!path) return null;
            const status = path.terminal.kind === "respond" ? path.terminal.status : null;
            const calls = path.steps.filter((s) => s.kind === "call");
            return (
              <li key={share.pathId} className="rounded-md border border-line bg-surface px-2 py-1">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                    <span className="w-14 font-medium tabular-nums">
                      {percent(share.share, share.share < 0.01 ? 2 : 1)}
                    </span>
                    <StatusBadge status={status} />
                    <span className="text-fg">{describePath(path)}</span>
                    <span className="ml-auto text-fg-subtle tabular-nums">
                      {milliseconds(share.meanMs)} on average
                    </span>
                  </summary>
                  <ul className="mt-1 flex flex-col gap-0.5 pl-16 text-xs text-fg-muted">
                    {calls.map((call) => (
                      <li key={call.stepId} className="tabular-nums">
                        {componentLabel(attempt, call.target)} · {call.action} → {call.outcome}:{" "}
                        {call.outcome === "error"
                          ? "failed"
                          : `${milliseconds(metrics.components.get(call.target)?.latencyMs[step] ?? 0)} at the component`}
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            );
          })}
        </ol>
      )}
      {reached < 0.999 && shares.length > 0 && (
        <p className="text-xs text-fg-muted">
          {percent(1 - reached, 1)} do not reach the handler's steps (rejected on the way in, or
          waiting in a backlog).
        </p>
      )}
    </section>
  );
}

/** One line of the event log. */
function describeMark(mark: TimelineMark, who: string): string {
  switch (mark.kind) {
    case "load":
      return mark.label;
    case "fault-start":
      return `${mark.label} starts${who ? ` (${who})` : ""}`;
    case "fault-end":
      return `${mark.label} ends${who ? ` (${who})` : ""}`;
    case "overload-start":
      return `${who} over capacity`;
    case "overload-end":
      return `${who} back under capacity`;
    case "restart":
      return `${mark.label}: ${who} ${mark.componentIds.length > 1 ? "start" : "starts"} empty`;
    default:
      // Autoscaling and breaker marks describe themselves.
      return mark.label;
  }
}

function EventLog({ metrics }: { readonly metrics: TimelineMetrics }) {
  const attempt = useAttemptStore((s) => s.attempt);
  if (metrics.marks.length === 0) return null;
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold text-fg-muted">Events</h4>
      <ol className="flex flex-col gap-0.5 text-sm text-fg">
        {metrics.marks.map((mark) => {
          const who = mark.componentIds.map((id) => componentLabel(attempt, id)).join(", ");
          const what = describeMark(mark, who);
          return (
            <li key={`${mark.at}-${mark.kind}-${what}`} className="tabular-nums">
              <button
                type="button"
                className="inline-block w-14 text-left text-info-fg underline-offset-2 hover:underline"
                aria-label={`Show the design at ${mark.at} seconds`}
                onClick={() =>
                  useUi.getState().setTimelineCursor({
                    timelineId: metrics.timeline.id,
                    step: stepAt(metrics, mark.at),
                  })
                }
              >
                {mark.at} s
              </button>
              {what}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
