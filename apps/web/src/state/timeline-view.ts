import type { TimelineMetrics } from "@archdrill/engine";
import { useMemo } from "react";
import type { CanvasLoad } from "../canvas/projection";
import { useEvaluation, useScenarioLoad } from "./evaluation";
import { predictionKey, usePredictions } from "./predictions";
import { useUi } from "./ui-store";

/** The canvas's view of one moment of a timeline. */
export function timelineSnapshot(metrics: TimelineMetrics, step: number): CanvasLoad {
  const components = new Map(
    [...metrics.components].map(([id, series]) => {
      const utilization = series.utilization[step] ?? 0;
      return [
        id,
        {
          utilization,
          // The series keeps the busiest part only, so no separate hot-shard marker.
          hottestShardUtilization: utilization,
          instances: series.instances[step] ?? 0,
          faults: series.faults[step] ?? [],
          faultDisrupts: series.faultDisrupts[step] ?? false,
        },
      ] as const;
    }),
  );
  const connections = new Map(
    [...metrics.connections].map(([id, series]) => [id, series[step] ?? 0] as const),
  );
  return { components, connections };
}

/** The timeline the Timeline tab shows: the one picked, or the scenario's first. */
export function useShownTimeline(): TimelineMetrics | undefined {
  const timelines = useScenarioTimelines();
  const picked = useUi((s) => s.timelineId);
  return timelines.find((t) => t.timeline.id === picked) ?? timelines[0];
}

/** Whether a timeline still waits for the candidate's predictions. */
export function useGated(metrics: TimelineMetrics | undefined): boolean {
  const scenarioId = useUi((s) => s.scenarioId);
  const key = metrics ? predictionKey(scenarioId, metrics.timeline.id) : "";
  const revealed = usePredictions((s) => s.byTimeline[key]?.revealed === true);
  return (metrics?.timeline.predictions.length ?? 0) > 0 && !revealed;
}

/** The scenario's timelines, once it has been evaluated. */
export function useScenarioTimelines(): readonly TimelineMetrics[] {
  const { scenarios } = useEvaluation();
  const scenarioId = useUi((s) => s.scenarioId);
  const result = scenarios.find((s) => s.scenarioId === scenarioId);
  return result?.status === "evaluated" ? [...result.timelines.values()] : [];
}

export interface CanvasMoment {
  readonly label: string;
  readonly at: number;
}

/**
 * What the canvas shows: the moment picked on a timeline while the Timeline
 * tab is open, otherwise the selected environment.
 */
export function useCanvasLoad(): {
  readonly load: CanvasLoad | undefined;
  readonly moment: CanvasMoment | null;
} {
  const { metrics } = useScenarioLoad();
  const shown = useShownTimeline();
  const gated = useGated(shown);
  const cursor = useUi((s) => s.timelineCursor);
  const tab = useUi((s) => s.resultsTab);
  // Only the timeline on screen, and not before its predictions are in.
  const timeline = cursor && shown?.timeline.id === cursor.timelineId ? shown : undefined;
  const active = tab === "timeline" && cursor !== null && timeline !== undefined && !gated;
  const step = active ? Math.min(cursor.step, timeline.times.length - 1) : -1;
  // The canvas re-projects when its load changes identity, so a snapshot is made once per moment.
  const snapshot = useMemo(
    () => (timeline && step >= 0 ? timelineSnapshot(timeline, step) : undefined),
    [timeline, step],
  );
  if (!active || !snapshot) return { load: metrics, moment: null };
  return {
    load: snapshot,
    moment: { label: timeline.timeline.label, at: timeline.times[step] ?? 0 },
  };
}
