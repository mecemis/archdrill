import type { TimelineMetrics } from "@archdrill/engine";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { isSuccessPath } from "../predicates";
import {
  type CheckContext,
  type CheckOutcome,
  defineCheck,
  failed,
  MAX_DETAIL_LINES,
  notApplicable,
  passed,
} from "./types";

const MetricSchema = z.enum(["success-rate", "p99", "utilization"]);
type Metric = z.infer<typeof MetricSchema>;

const percent = (value: number) => `${(value * 100).toFixed(value > 0.999 && value < 1 ? 2 : 1)}%`;
const ms = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
const seconds = (value: number) => `${Number(value.toFixed(1))} s`;

interface Series {
  readonly timeline: TimelineMetrics;
  /** The metric per step, or null at steps with nothing to judge (no traffic). */
  readonly values: readonly (number | null)[];
  readonly subject: string;
  /** Success rates must stay above the threshold; latency and utilisation below it. */
  readonly within: (value: number) => boolean;
  readonly format: (value: number) => string;
  readonly worse: (a: number, b: number) => boolean;
}

function seriesFor(
  ctx: CheckContext,
  params: { timeline: string; metric: Metric; operation?: string | undefined; threshold: number },
): Series | string {
  const timeline = ctx.timelines.get(params.timeline);
  if (!timeline) return "This scenario does not run that timeline.";
  if (params.metric === "utilization") {
    const values = timeline.times.map((_, step) =>
      Math.max(0, ...[...timeline.components.values()].map((c) => c.utilization[step] ?? 0)),
    );
    return {
      timeline,
      values,
      subject: "The busiest component",
      within: (v) => v <= params.threshold,
      format: percent,
      worse: (a, b) => a > b,
    };
  }
  const operation = params.operation ? timeline.operations.get(params.operation) : undefined;
  if (!operation) return "Nothing in this design runs that operation on the timeline.";
  const label =
    ctx.problem.operations.find((o) => o.id === params.operation)?.label ?? params.operation ?? "";
  const source = params.metric === "success-rate" ? operation.successRate : operation.p99;
  const values = source.map((v, step) => ((operation.rate[step] ?? 0) > 0 ? v : null));
  return params.metric === "success-rate"
    ? {
        timeline,
        values,
        subject: label,
        within: (v) => v >= params.threshold,
        format: percent,
        worse: (a, b) => a < b,
      }
    : {
        timeline,
        values,
        subject: `${label} p99`,
        within: (v) => v <= params.threshold,
        format: ms,
        worse: (a, b) => a > b,
      };
}

/**
 * What a finding points at: what a fault hits during the steps, or what runs
 * over capacity; failing that, the operation's paths that do not succeed.
 */
function evidenceFor(
  ctx: CheckContext,
  timeline: TimelineMetrics,
  steps: readonly number[],
  operation: string | undefined,
): Evidence[] {
  const components = evidenceAt(timeline, steps);
  if (components.length > 0 || operation === undefined) return components;
  const analysed = ctx.analysis.operations.get(operation);
  if (!analysed) return [];
  return analysed.paths
    .filter((p) => !isSuccessPath(p, analysed.operation))
    .map((p): Evidence => ({ type: "path", operation, pathId: p.id }));
}

function evidenceAt(timeline: TimelineMetrics, steps: readonly number[]): Evidence[] {
  const ids = new Set<string>();
  for (const step of steps) {
    const t = timeline.times[step] ?? 0;
    for (const mark of timeline.marks) {
      if (mark.kind !== "fault-start" || mark.at > t) continue;
      const end = timeline.marks.find(
        (m) => m.kind === "fault-end" && m.label === mark.label && m.at >= mark.at,
      );
      if (!end || end.at > t) for (const id of mark.componentIds) ids.add(id);
    }
    for (const [id, series] of timeline.components) {
      if ((series.utilization[step] ?? 0) > 1) ids.add(id);
    }
  }
  return [...ids].map((componentId) => ({ type: "component", componentId }));
}

/** Contiguous runs of steps, as time ranges. */
function intervals(timeline: TimelineMetrics, steps: readonly number[]): string[] {
  const runs: [number, number][] = [];
  for (const step of steps) {
    const last = runs.at(-1);
    if (last && step === last[1] + 1) last[1] = step;
    else runs.push([step, step]);
  }
  return runs.map(([from, to]) => {
    const start = timeline.times[from] ?? 0;
    const end = timeline.times[to] ?? 0;
    return start === end ? `at ${seconds(start)}` : `from ${seconds(start)} to ${seconds(end)}`;
  });
}

const WindowParams = {
  timeline: z.string().min(1),
  metric: MetricSchema,
  /** For success rate and p99. */
  operation: z.string().min(1).optional(),
  /** A minimum for success rates; a maximum for p99 (ms) and utilisation. */
  threshold: z.number().positive(),
};

const requireOperation = (p: { metric: Metric; operation?: string | undefined }) =>
  p.metric === "utilization" || p.operation !== undefined;

/** A metric stays within bounds over a window of a timeline, give or take a grace period. */
export const timelineHolds = defineCheck({
  id: "timeline-holds",
  description: "A metric stays within bounds throughout a window of a timeline.",
  params: z
    .strictObject({
      ...WindowParams,
      from: z.number().min(0).optional(),
      to: z.number().positive().optional(),
      /** Seconds the metric may spend out of bounds without losing credit. */
      graceSec: z.number().min(0).default(0),
    })
    .refine(requireOperation, { message: "success-rate and p99 need an operation" }),
  run(params, ctx): CheckOutcome {
    const series = seriesFor(ctx, params);
    if (typeof series === "string") return notApplicable(series);
    const { timeline, values } = series;
    const from = params.from ?? 0;
    const to = params.to ?? timeline.timeline.durationSec;
    const window = values
      .map((value, step) => ({ value, step, t: timeline.times[step] ?? 0 }))
      .filter((p) => p.t >= from && p.t <= to && p.value !== null);
    if (window.length === 0) return notApplicable("Nothing runs in that window.");
    const step = timeline.timeline.stepSec;
    const outside = window.filter((p) => !series.within(p.value as number));
    let worst = window[0];
    for (const p of window) {
      if (worst && series.worse(p.value as number, worst.value as number)) worst = p;
    }
    const worstText = worst ? `${series.format(worst.value as number)} at ${seconds(worst.t)}` : "";
    const label = timeline.timeline.label;
    if (outside.length * step <= params.graceSec) {
      return passed(
        `${series.subject} stays within bounds over ${label}; the worst is ${worstText}.`,
      );
    }
    const spent = outside.length * step;
    const span = Math.max(step, window.length * step);
    const fraction = Math.max(0, 1 - (spent - params.graceSec) / span);
    const message = `${series.subject} is out of bounds (${params.metric === "success-rate" ? "below" : "above"} ${series.format(params.threshold)}) for ${seconds(spent)} of ${label}, at worst ${worstText}.`;
    const evidence = evidenceAt(
      timeline,
      outside.map((p) => p.step),
    );
    const details = intervals(
      timeline,
      outside.map((p) => p.step),
    ).slice(0, MAX_DETAIL_LINES);
    if (fraction <= 0) return failed(message, evidence, details);
    return { status: "partial", fraction, message, details, evidence };
  },
});

/** After an event, a metric is back within bounds soon enough, and stays there. */
export const timelineRecovers = defineCheck({
  id: "timeline-recovers",
  description: "After a moment of a timeline, a metric returns within bounds soon enough.",
  params: z
    .strictObject({
      ...WindowParams,
      metric: z.enum(["success-rate", "p99"]),
      /** Seconds into the timeline from which recovery is measured, usually when a fault ends. */
      after: z.number().min(0),
      withinSec: z.number().min(0),
    })
    .refine(requireOperation, { message: "success-rate and p99 need an operation" }),
  run(params, ctx): CheckOutcome {
    const series = seriesFor(ctx, params);
    if (typeof series === "string") return notApplicable(series);
    const { timeline, values } = series;
    const label = timeline.timeline.label;
    const steps = values
      .map((value, step) => ({ value, step, t: timeline.times[step] ?? 0 }))
      .filter((p) => p.t >= params.after && p.value !== null);
    if (steps.length === 0) return notApplicable("Nothing runs after that moment.");
    // The first moment from which the metric stays within bounds to the end.
    let recovered: (typeof steps)[number] | undefined;
    for (let i = steps.length - 1; i >= 0; i--) {
      const point = steps[i];
      if (!point || !series.within(point.value as number)) break;
      recovered = point;
    }
    const bound = `${params.metric === "success-rate" ? "above" : "below"} ${series.format(params.threshold)}`;
    if (!recovered) {
      const last = steps.at(-1);
      return failed(
        `${series.subject} is not back ${bound} by the end of ${label} (${series.format(last?.value as number)} at ${seconds(last?.t ?? 0)}).`,
        evidenceFor(ctx, timeline, [last?.step ?? 0], params.operation),
      );
    }
    if (recovered === steps[0]) {
      return passed(
        `${series.subject} stays ${bound} from ${seconds(params.after)} into ${label}.`,
      );
    }
    const delay = recovered.t - params.after;
    const message = `${series.subject} is back ${bound} ${seconds(delay)} after ${seconds(params.after)} into ${label}; the target is within ${seconds(params.withinSec)}.`;
    if (delay <= params.withinSec) return passed(message);
    const late = steps.filter((p) => p.t < recovered.t).map((p) => p.step);
    return {
      status: "partial",
      fraction: params.withinSec / delay,
      message,
      details: intervals(timeline, late).slice(0, MAX_DETAIL_LINES),
      evidence: evidenceFor(ctx, timeline, late, params.operation),
    };
  },
});
