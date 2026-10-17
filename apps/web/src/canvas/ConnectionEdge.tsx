import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from "@xyflow/react";
import { memo } from "react";
import { useLayout } from "../state/layout";
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

/** Seconds a dot takes along an edge: slower for light traffic, at most this slow. */
const SLOWEST_TRIP_SEC = 3;
const FASTEST_TRIP_SEC = 0.9;
/** How much each tenfold increase in traffic speeds the dots up, in seconds. */
const TRIP_SEC_PER_DECADE = 0.4;
/** Messages through a queue move slower than calls, to tell them apart. */
const ASYNC_SLOWDOWN = 1.6;

function dotColor(data: ConnectionEdgeData): string {
  if (data.targetHealth === "critical") return "var(--bad)";
  if (data.targetHealth === "warn") return "var(--warn)";
  return data.steps.length > 0 || data.ingress ? "var(--accent)" : "var(--info)";
}

/**
 * Dots moving from source to target: more and faster with more traffic,
 * coloured by the health of the component they reach.
 */
function TrafficDots({ path, data }: { readonly path: string; readonly data: ConnectionEdgeData }) {
  const rate = data.rate ?? 0;
  const count = rate >= 10_000 ? 3 : rate >= 100 ? 2 : 1;
  const trip =
    Math.min(
      SLOWEST_TRIP_SEC,
      Math.max(
        FASTEST_TRIP_SEC,
        SLOWEST_TRIP_SEC - TRIP_SEC_PER_DECADE * Math.log10(Math.max(1, rate)),
      ),
    ) * (data.messaging ? ASYNC_SLOWDOWN : 1);
  const color = dotColor(data);
  return (
    <g className="traffic-dots">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the dots are identical and never reorder
        <circle key={i} r={2.6} fill={color} opacity={1 - i * 0.2}>
          <animateMotion
            dur={`${trip.toFixed(2)}s`}
            begin={`${((i * trip) / count).toFixed(2)}s`}
            repeatCount="indefinite"
            path={path}
          />
        </circle>
      ))}
    </g>
  );
}

function ConnectionEdgeView(props: EdgeProps<Edge<ConnectionEdgeData>>) {
  const { id, data, selected } = props;
  const animate = useLayout((s) => s.animateTraffic);
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
          strokeDasharray: data?.messaging ? "6 4" : undefined,
          opacity: data?.emphasis === "dimmed" ? 0.3 : 1,
        }}
      />
      {animate && data && (data.rate ?? 0) > 0 && data.emphasis !== "dimmed" && (
        <TrafficDots path={path} data={data} />
      )}
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
