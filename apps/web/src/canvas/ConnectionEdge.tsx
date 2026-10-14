import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from "@xyflow/react";
import { memo } from "react";
import { compact } from "../ui/format";
import type { ConnectionEdgeData } from "./projection";

const MIN_LABELLED_LENGTH = 90;

/** Edge colours, as design tokens; each has an arrowhead of its own. */
const STROKES = {
  error: "var(--bad)",
  selected: "var(--accent-strong)",
  highlighted: "var(--warn)",
  flow: "var(--accent)",
  idle: "var(--fg-faint)",
} as const;

type Stroke = keyof typeof STROKES;

function strokeFor(data: ConnectionEdgeData | undefined, selected: boolean | undefined): Stroke {
  if (data?.hasError) return "error";
  if (selected) return "selected";
  if (data?.emphasis === "highlighted") return "highlighted";
  if (data && (data.steps.length > 0 || data.ingress)) return "flow";
  return "idle";
}

function ConnectionEdgeView(props: EdgeProps<Edge<ConnectionEdgeData>>) {
  const { id, data, selected } = props;
  const [path, labelX, labelY] = getBezierPath(props);
  const stroke = strokeFor(data, selected);
  const active = data ? data.steps.length > 0 || data.ingress : false;
  // Short edges have no room for a rate label without covering the nodes.
  const roomForRate =
    Math.hypot(props.targetX - props.sourceX, props.targetY - props.sourceY) > MIN_LABELLED_LENGTH;
  const rate = roomForRate ? (data?.rate ?? 0) : 0;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#arrow-${stroke})`}
        style={{
          stroke: STROKES[stroke],
          strokeWidth: selected ? 3 : active ? 2.25 : 1.5,
          strokeDasharray: data?.mode === "async" ? "6 4" : undefined,
          opacity: data?.emphasis === "dimmed" ? 0.3 : 1,
        }}
      />
      {data && (data.steps.length > 0 || rate > 0) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute flex gap-0.5"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {rate > 0 && (
              <span className="rounded-md border border-line bg-elevated px-1.5 text-[11px] font-medium text-fg-muted tabular-nums shadow-card">
                {compact(rate)}/s
              </span>
            )}
            {data.steps.map((n) => (
              <span
                key={n}
                className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-on-accent shadow-card"
              >
                {n}
              </span>
            ))}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const ConnectionEdge = memo(ConnectionEdgeView);

/** Arrowhead definitions for every stroke colour the edges use. */
export function EdgeMarkers() {
  return (
    <svg className="absolute h-0 w-0" aria-hidden="true">
      <defs>
        {(Object.keys(STROKES) as Stroke[]).map((stroke) => (
          <marker
            key={stroke}
            id={`arrow-${stroke}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5.5"
            markerHeight="5.5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={STROKES[stroke]} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}
