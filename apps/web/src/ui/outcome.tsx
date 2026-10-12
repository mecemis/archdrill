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
  positive: { className: "border-emerald-300 bg-emerald-50 text-emerald-800", icon: CircleCheck },
  absent: { className: "border-amber-300 bg-amber-50 text-amber-800", icon: CircleDashed },
  negative: { className: "border-zinc-300 bg-zinc-100 text-zinc-700", icon: CircleMinus },
  conflict: { className: "border-violet-300 bg-violet-50 text-violet-800", icon: Swords },
  error: { className: "border-rose-300 bg-rose-50 text-rose-800", icon: CircleX },
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
      ? "bg-rose-100 text-rose-800"
      : status >= 500
        ? "bg-rose-100 text-rose-800"
        : status >= 400
          ? "bg-amber-100 text-amber-900"
          : "bg-emerald-100 text-emerald-800";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${tone}`}>
      {status === null ? "unhandled" : status}
    </span>
  );
}
