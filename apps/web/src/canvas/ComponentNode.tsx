import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";
import { type MouseEvent, memo } from "react";
import { useUi } from "../state/ui-store";
import { percent, utilizationTone } from "../ui/format";
import { KindChip } from "../ui/icons";
import type { FindingTone, NodeFindings } from "./node-findings";
import type { ComponentNodeData } from "./projection";

const EMPHASIS_CLASSES = {
  normal: "",
  highlighted: "ring-2 ring-warn ring-offset-2 ring-offset-app",
  dimmed: "opacity-35",
} as const;

const HANDLE_CLASS = "!h-2.5 !w-2.5 !border-2 !border-elevated !bg-fg-faint hover:!bg-accent";

function frameClass(data: ComponentNodeData, selected: boolean | undefined): string {
  if (data.hasError) return "border-bad ring-1 ring-bad/40";
  if (selected) return "border-accent ring-2 ring-accent/35";
  if (data.callable) return "border-accent border-dashed bg-accent-soft";
  if (data.health === "critical") return "health-critical border-bad ring-2 ring-bad/30";
  if (data.health === "warn") return "border-warn ring-2 ring-warn/25";
  return "border-line hover:border-line-strong";
}

const BADGE_TONES: Readonly<Record<FindingTone, string>> = {
  bad: "bg-bad",
  warn: "bg-warn",
  info: "bg-info",
};

/** Opens the most serious finding about this component and shows its evidence. */
function showFinding(event: MouseEvent, findings: NodeFindings) {
  event.stopPropagation();
  const ui = useUi.getState();
  ui.setResultsTab("findings");
  if (ui.pinned?.key !== findings.key) ui.togglePin(findings.key, findings.highlight);
}

function FindingsBadge({ findings }: { readonly findings: NodeFindings }) {
  const plural = findings.count === 1 ? "" : "s";
  return (
    <button
      type="button"
      className={`nodrag absolute -top-2 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold text-on-accent shadow-card ring-2 ring-app transition-transform hover:scale-110 ${BADGE_TONES[findings.tone]}`}
      onClick={(event) => showFinding(event, findings)}
      aria-label={`${findings.count} open finding${plural}, led by: ${findings.title}`}
      title={`${findings.count} open finding${plural}: ${findings.title}`}
    >
      {findings.count}
    </button>
  );
}

function scaleLabel(data: ComponentNodeData): string | null {
  const count = instanceLabel(data);
  if (count === null || data.zones === null || data.zones < 2) return count;
  return `${count} · ${data.zones} AZ`;
}

function instanceLabel(data: ComponentNodeData): string | null {
  if (!data.replicable && (data.shards ?? 1) <= 1) return null;
  if (data.shards !== null && data.shards > 1) return `${data.shards}×${data.replicas}`;
  if (data.autoscaleMax !== null) return `×${data.replicas}–${data.autoscaleMax}`;
  return `×${data.replicas}`;
}

function scaleTitle(data: ComponentNodeData): string {
  const counts =
    data.autoscaleMax !== null
      ? "replicas, autoscaling up to the maximum"
      : data.shards !== null
        ? "shards × replicas"
        : "replicas";
  return data.zones !== null && data.zones > 1
    ? `${counts}, spread over ${data.zones} availability zones`
    : counts;
}

function ComponentNodeView({ data, selected }: NodeProps<Node<ComponentNodeData>>) {
  const scale = scaleLabel(data);
  return (
    <div
      className={`relative w-48 rounded-xl border bg-elevated px-2.5 py-2 text-left shadow-card transition-[opacity,box-shadow,border-color] ${frameClass(data, selected)} ${EMPHASIS_CLASSES[data.emphasis]}`}
      data-testid={`node-${data.label}`}
    >
      {data.findings && <FindingsBadge findings={data.findings} />}
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
                title={scaleTitle(data)}
              >
                {scale}
              </span>
            )}
          </div>
        </div>
      </div>
      {(data.entities.length > 0 || data.isHandler || data.standby || data.proxied) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {data.isHandler && (
            <span className="rounded-md bg-accent-soft px-1.5 text-[10px] font-semibold text-accent-fg">
              handler
            </span>
          )}
          {data.standby && (
            <span
              className="rounded-md bg-muted px-1.5 text-[10px] font-semibold text-fg-muted"
              title="Keeps a standby copy in a second region"
            >
              standby region
            </span>
          )}
          {data.proxied && (
            <span
              className="rounded-md bg-muted px-1.5 text-[10px] font-semibold text-fg-muted"
              title="A connection proxy holds its callers' pools"
            >
              proxy
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
        <div
          className={`mt-1.5 flex items-start gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
            data.faultDisrupts ? "bg-bad-soft text-bad-fg" : "bg-warn-soft text-warn-fg"
          }`}
        >
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
