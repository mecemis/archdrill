import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";
import { memo } from "react";
import { percent, utilizationTone } from "../ui/format";
import { KindChip } from "../ui/icons";
import type { ComponentNodeData } from "./projection";

const EMPHASIS_CLASSES = {
  normal: "",
  highlighted: "ring-2 ring-warn ring-offset-2 ring-offset-app",
  dimmed: "opacity-35",
} as const;

const HANDLE_CLASS = "!h-2.5 !w-2.5 !border-2 !border-elevated !bg-fg-faint";

function frameClass(data: ComponentNodeData, selected: boolean | undefined): string {
  if (data.hasError) return "border-bad ring-1 ring-bad/40";
  if (selected) return "border-accent ring-2 ring-accent/35";
  if (data.callable) return "border-accent border-dashed bg-accent-soft";
  return "border-line hover:border-line-strong";
}

function scaleLabel(data: ComponentNodeData): string | null {
  if (!data.replicable && (data.shards ?? 1) <= 1) return null;
  if (data.shards !== null && data.shards > 1) return `${data.shards}×${data.replicas}`;
  if (data.autoscaleMax !== null) return `×${data.replicas}–${data.autoscaleMax}`;
  return `×${data.replicas}`;
}

function ComponentNodeView({ data, selected }: NodeProps<Node<ComponentNodeData>>) {
  const scale = scaleLabel(data);
  return (
    <div
      className={`w-48 rounded-xl border bg-elevated px-2.5 py-2 text-left shadow-card transition-[opacity,box-shadow] ${frameClass(data, selected)} ${EMPHASIS_CLASSES[data.emphasis]}`}
      data-testid={`node-${data.label}`}
    >
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      <div className="flex items-center gap-2">
        <KindChip kind={data.kind} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-tight font-semibold text-fg">
            {data.label}
          </div>
          <div className="flex items-center gap-1 text-[11px] leading-tight text-fg-subtle">
            <span className="truncate">
              {data.flavorLabel}
              {data.sizeLabel ? ` · ${data.sizeLabel}` : ""}
            </span>
            {scale && (
              <span
                className="ml-auto shrink-0 font-medium text-fg-muted tabular-nums"
                title={
                  data.autoscaleMax !== null
                    ? "replicas, autoscaling up to the maximum"
                    : data.shards !== null
                      ? "shards × replicas"
                      : "replicas"
                }
              >
                {scale}
              </span>
            )}
          </div>
        </div>
      </div>
      {(data.entities.length > 0 || data.isHandler) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {data.isHandler && (
            <span className="rounded-md bg-accent-soft px-1.5 text-[10px] font-semibold text-accent-fg">
              handler
            </span>
          )}
          {data.entities.map((entity) => (
            <span
              key={entity}
              className="rounded-md bg-cat-storage/14 px-1.5 text-[10px] font-semibold text-ok-fg"
            >
              stores {entity}
            </span>
          ))}
        </div>
      )}
      {data.faults.length > 0 && (
        <div className="mt-1.5 flex items-start gap-1 rounded-md bg-bad-soft px-1.5 py-0.5 text-[11px] font-medium text-bad-fg">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{data.faults.join("; ")}</span>
        </div>
      )}
      {data.utilization !== null && (
        <div
          className="mt-2 flex items-center gap-1.5"
          title="Utilisation in the selected environment"
        >
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-track" aria-hidden="true">
            <span
              className={`block h-full rounded-full ${utilizationTone(data.utilization)}`}
              style={{ width: `${Math.min(100, data.utilization * 100)}%` }}
            />
          </span>
          <span
            className={`text-[11px] tabular-nums ${data.utilization > 1 ? "font-semibold text-bad-fg" : "text-fg-muted"}`}
          >
            {percent(data.utilization, 0)}
          </span>
        </div>
      )}
      {(data.hotShard !== null || (data.autoscaleMax !== null && data.running !== null)) && (
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-fg-subtle tabular-nums">
          {data.autoscaleMax !== null && data.running !== null && (
            <span>{data.running} running</span>
          )}
          {data.hotShard !== null && (
            <span className={data.hotShard > 1 ? "font-semibold text-bad-fg" : "text-warn-fg"}>
              hot shard {percent(data.hotShard, 0)}
            </span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
    </div>
  );
}

export const ComponentNode = memo(ComponentNodeView);
