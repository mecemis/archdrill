import { type OutcomeTone, outcomeTone } from "@archdrill/model";
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  type LucideIcon,
  Swords,
} from "lucide-react";

const TONE_STYLES: Readonly<
  Record<OutcomeTone, { readonly className: string; readonly icon: LucideIcon }>
> = {
  positive: { className: "border-ok-line bg-ok-soft text-ok-fg", icon: CircleCheck },
  absent: { className: "border-warn-line bg-warn-soft text-warn-fg", icon: CircleDashed },
  negative: { className: "border-line-strong bg-muted text-fg-muted", icon: CircleMinus },
  conflict: { className: "border-accent-line bg-accent-soft text-accent-fg", icon: Swords },
  error: { className: "border-bad-line bg-bad-soft text-bad-fg", icon: CircleX },
};

/** Outcome label with colour, icon and border so tone never relies on colour alone. */
export function OutcomeChip({ outcome }: { readonly outcome: string }) {
  const style = TONE_STYLES[outcomeTone(outcome)];
  const Icon = style.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${style.className}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {outcome}
    </span>
  );
}

const REASONS: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  404: "Not Found",
  409: "Conflict",
  410: "Gone",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

export const COMMON_STATUSES = Object.keys(REASONS).map(Number);

export function statusLabel(status: number): string {
  const reason = REASONS[status];
  return reason ? `${status} ${reason}` : String(status);
}

export function StatusBadge({ status }: { readonly status: number | null }) {
  const tone =
    status === null
      ? "bg-bad-soft text-bad-fg"
      : status >= 500
        ? "bg-bad-soft text-bad-fg"
        : status >= 400
          ? "bg-warn-soft text-warn-fg"
          : "bg-ok-soft text-ok-fg";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${tone}`}>
      {status === null ? "unhandled" : status}
    </span>
  );
}
