import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";
import { memo } from "react";
import { percent, utilizationTone } from "../ui/format";
import { KindIcon } from "../ui/icons";
import type { ComponentNodeData } from "./projection";

const EMPHASIS_CLASSES = {
  normal: "",
  highlighted: "ring-2 ring-amber-400 ring-offset-2",
  dimmed: "opacity-35",
} as const;

function ComponentNodeView({ data, selected }: NodeProps<Node<ComponentNodeData>>) {
  const border = data.hasError
    ? "border-rose-500"
    : selected
      ? "border-sky-600"
      : data.callable
        ? "border-emerald-500 border-dashed"
        : "border-zinc-300";
  return (
    <div
      className={`w-48 rounded-lg border-2 bg-white px-3 py-2 text-left shadow-sm transition-opacity ${border} ${EMPHASIS_CLASSES[data.emphasis]}`}
      data-testid={`node-${data.label}`}
    >
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !bg-zinc-400" />
      <div className="flex items-center gap-2">
        <KindIcon kind={data.kind} className="h-4 w-4 shrink-0 text-zinc-600" />
        <span className="truncate text-sm font-semibold text-zinc-900">{data.label}</span>
        {(data.replicable || (data.shards ?? 1) > 1) && (
          <span
            className="ml-auto rounded bg-zinc-100 px-1.5 text-xs font-medium text-zinc-700 tabular-nums"
            title={data.shards !== null ? "shards × replicas" : "replicas"}
          >
            {data.shards !== null && data.shards > 1
              ? `${data.shards}×${data.replicas}`
              : data.autoscaleMax !== null
                ? `×${data.replicas}–${data.autoscaleMax}`
                : `×${data.replicas}`}
          </span>
        )}
      </div>
      <div className="mt-0.5 truncate text-xs text-zinc-600">
        {data.flavorLabel}
        {data.sizeLabel ? ` · ${data.sizeLabel}` : ""}
      </div>
      {(data.entities.length > 0 || data.isHandler) && (
        <div className="mt-1 flex flex-wrap gap-1">
          {data.isHandler && (
            <span className="rounded bg-sky-100 px-1.5 text-[11px] font-medium text-sky-800">
              handler
            </span>
          )}
          {data.entities.map((entity) => (
            <span
              key={entity}
              className="rounded bg-violet-100 px-1.5 text-[11px] font-medium text-violet-800"
            >
              stores {entity}
            </span>
          ))}
        </div>
      )}
      {data.faults.length > 0 && (
        <div className="mt-1 flex items-start gap-1 rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-800">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{data.faults.join("; ")}</span>
        </div>
      )}
      {data.utilization !== null && (
        <div
          className="mt-1.5 flex items-center gap-1.5"
          title="Utilisation in the selected environment"
        >
          <span
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200"
            aria-hidden="true"
          >
            <span
              className={`block h-full rounded-full ${utilizationTone(data.utilization)}`}
              style={{ width: `${Math.min(100, data.utilization * 100)}%` }}
            />
          </span>
          <span
            className={`text-[11px] tabular-nums ${data.utilization > 1 ? "font-semibold text-rose-700" : "text-zinc-600"}`}
          >
            {percent(data.utilization, 0)}
          </span>
        </div>
      )}
      {(data.hotShard !== null || (data.autoscaleMax !== null && data.running !== null)) && (
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] tabular-nums text-zinc-600">
          {data.autoscaleMax !== null && data.running !== null && (
            <span>{data.running} running</span>
          )}
          {data.hotShard !== null && (
            <span className={data.hotShard > 1 ? "font-semibold text-rose-700" : "text-amber-700"}>
              hot shard {percent(data.hotShard, 0)}
            </span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !bg-zinc-400" />
    </div>
  );
}

export const ComponentNode = memo(ComponentNodeView);
