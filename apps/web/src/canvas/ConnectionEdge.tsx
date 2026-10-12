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

function strokeFor(data: ConnectionEdgeData | undefined, selected: boolean | undefined): string {
  if (data?.hasError) return "#e11d48";
  if (selected) return "#0284c7";
  if (data?.emphasis === "highlighted") return "#d97706";
  if (data && (data.steps.length > 0 || data.ingress)) return "#0f766e";
  return "#a1a1aa";
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
        markerEnd={`url(#arrow-${stroke.slice(1)})`}
        style={{
          stroke,
          strokeWidth: active || selected ? 2.5 : 1.5,
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
              <span className="rounded bg-white/90 px-1 text-[11px] font-medium text-zinc-700 tabular-nums shadow-sm">
                {compact(rate)}/s
              </span>
            )}
            {data.steps.map((n) => (
              <span
                key={n}
                className="flex h-5 min-w-5 items-center justify-center rounded-full bg-teal-700 px-1 text-[11px] font-semibold text-white"
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

const MARKER_COLORS = ["e11d48", "0284c7", "d97706", "0f766e", "a1a1aa"];

/** Arrowhead definitions for every stroke colour the edges use. */
export function EdgeMarkers() {
  return (
    <svg className="absolute h-0 w-0" aria-hidden="true">
      <defs>
        {MARKER_COLORS.map((color) => (
          <marker
            key={color}
            id={`arrow-${color}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={`#${color}`} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}
