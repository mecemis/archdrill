import type { TimelineMark, TimelineMetrics } from "@archdrill/engine";
import { useState } from "react";
import { activePack } from "../../state/content";
import { useEvaluation } from "../../state/evaluation";
import { useAttemptStore } from "../../state/store";
import { useUi } from "../../state/ui-store";
import { compact, milliseconds, percent } from "../../ui/format";
import { LineChart, type TimeBand } from "../../ui/LineChart";
import { Tabs } from "../../ui/primitives";
import { componentLabel } from "../flow/step-label";

/** Components worth charting: those that come anywhere near capacity. */
const UTILIZATION_SHOWN = 0.3;
const MAX_COMPONENTS = 5;

/** How the design behaves over time in the scenario's timelines. */
export function TimelinePanel() {
  const { scenarios } = useEvaluation();
  const scenarioId = useUi((s) => s.scenarioId);
  const result = scenarios.find((s) => s.scenarioId === scenarioId);
  const timelines = result?.status === "evaluated" ? [...result.timelines.values()] : [];
  const [selected, setSelected] = useState<string | null>(null);
  const metrics = timelines.find((t) => t.timeline.id === selected) ?? timelines[0];
  if (!metrics) {
    return (
      <p className="p-3 text-sm text-zinc-500">
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
          onChange={setSelected}
          options={timelines.map((t) => ({ id: t.timeline.id, label: t.timeline.label }))}
        />
      )}
      <TimelineCharts metrics={metrics} />
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

function TimelineCharts({ metrics }: { readonly metrics: TimelineMetrics }) {
  const attempt = useAttemptStore((s) => s.attempt);
  const label = (id: string) => activePack.problem.operations.find((o) => o.id === id)?.label ?? id;
  const bands = faultBands(metrics);
  const operations = [...metrics.operations].filter(([, s]) => s.rate.some((r) => r > 0));
  const judged = (values: readonly number[], rate: readonly number[]) =>
    values.map((v, i) => ((rate[i] ?? 0) > 0 ? v : null));
  const successes = operations.map(([id, s]) => ({
    label: label(id),
    values: judged(s.successRate, s.rate),
  }));
  const lowest = Math.min(
    0.99,
    ...successes.flatMap((s) => s.values.filter((v): v is number => v !== null)),
  );
  const latencies = operations.map(([id, s]) => ({
    label: label(id),
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
  const caches = [...metrics.caches].map(([key, values]) => {
    const [component, entity] = key.split("|");
    return { label: `${componentLabel(attempt, component ?? "")} · ${entity ?? ""}`, values };
  });
  const backlogs = operations.filter(([, s]) => s.backlog.some((b) => b > 0));

  return (
    <>
      {metrics.timeline.description && (
        <p className="text-sm text-zinc-700">{metrics.timeline.description}</p>
      )}
      {metrics.unsettledSteps > 0 && (
        <p className="rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
          The load model did not settle in {metrics.unsettledSteps} steps; those numbers are
          approximate.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <LineChart
          title="Success rate"
          times={metrics.times}
          series={successes}
          domain={[lowest, 1]}
          format={(v) => percent(v, v > 0.999 && v < 1 ? 2 : 1)}
          bands={bands}
        />
        <LineChart
          title="p99 latency of successful requests"
          times={metrics.times}
          series={latencies}
          domain={[0, slowest * 1.1]}
          format={milliseconds}
          bands={bands}
        />
        {busy.length > 0 && (
          <LineChart
            title="Utilisation (the busiest part of each component)"
            times={metrics.times}
            series={busy.map((c) => ({
              label: componentLabel(attempt, c.id),
              values: c.series.utilization,
            }))}
            domain={[0, busiest]}
            format={(v) => percent(v, 0)}
            limit={{ value: 1, label: "capacity" }}
            bands={bands}
          />
        )}
        {caches.length > 0 && (
          <LineChart
            title="Cache hit ratio"
            times={metrics.times}
            series={caches}
            domain={[0, 1]}
            format={(v) => percent(v, 0)}
            bands={bands}
          />
        )}
        {backlogs.length > 0 && (
          <LineChart
            title="Backlog (items waiting)"
            times={metrics.times}
            series={backlogs.map(([id, s]) => ({ label: label(id), values: s.backlog }))}
            domain={[0, Math.max(1, ...backlogs.flatMap(([, s]) => s.backlog))]}
            format={compact}
            bands={bands}
          />
        )}
      </div>
      <EventLog marks={metrics.marks} />
    </>
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

function EventLog({ marks }: { readonly marks: readonly TimelineMark[] }) {
  const attempt = useAttemptStore((s) => s.attempt);
  if (marks.length === 0) return null;
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold text-zinc-600">Events</h4>
      <ol className="flex flex-col gap-0.5 text-sm text-zinc-800">
        {marks.map((mark) => {
          const who = mark.componentIds.map((id) => componentLabel(attempt, id)).join(", ");
          const what = describeMark(mark, who);
          return (
            <li key={`${mark.at}-${mark.kind}-${what}`} className="tabular-nums">
              <span className="inline-block w-14 text-zinc-500">{mark.at} s</span>
              {what}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
