import type { Analysis } from "@archdrill/engine";
import type { CheckResult } from "@archdrill/evaluator";
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  Crosshair,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { highlightFromEvidence } from "../../state/evaluation";
import { type Highlight, useUi } from "../../state/ui-store";

const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2 } as const;

function order(a: CheckResult, b: CheckResult): number {
  if (a.gateFailed !== b.gateFailed) return a.gateFailed ? -1 : 1;
  return SEVERITY_ORDER[a.instance.severity] - SEVERITY_ORDER[b.instance.severity];
}

export function Findings({
  checks,
  analysis,
}: {
  readonly checks: readonly CheckResult[];
  readonly analysis: Analysis;
}) {
  const open = checks
    .filter(
      (c) => c.instance.signal === "baseline" && (c.status === "fail" || c.status === "partial"),
    )
    .sort(order);
  const signals = checks.filter((c) => c.instance.signal !== "baseline" && c.status !== "n/a");
  const passed = checks.filter((c) => c.instance.signal === "baseline" && c.status === "pass");
  const notApplicable = checks.filter((c) => c.status === "n/a");

  return (
    <div className="flex flex-col gap-2 p-3">
      {open.length === 0 && (
        <p className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <CircleCheck className="h-4 w-4" aria-hidden="true" />
          No open findings in this scenario.
        </p>
      )}
      {open.map((check) => (
        <FindingCard key={check.instance.id} check={check} analysis={analysis} />
      ))}
      {signals.length > 0 && (
        <Group
          title={`Signals (${signals.filter((s) => s.status === "pass").length}/${signals.length})`}
        >
          {signals.map((check) => (
            <FindingCard key={check.instance.id} check={check} analysis={analysis} compact />
          ))}
        </Group>
      )}
      <Group title={`Passed (${passed.length})`}>
        {passed.map((check) => (
          <FindingCard key={check.instance.id} check={check} analysis={analysis} compact />
        ))}
      </Group>
      {notApplicable.length > 0 && (
        <Group title={`Not applicable to this design (${notApplicable.length})`}>
          {notApplicable.map((check) => (
            <p key={check.instance.id} className="px-2 text-xs text-zinc-500">
              {check.instance.title}: {check.message}
            </p>
          ))}
        </Group>
      )}
    </div>
  );
}

function onCanvas(highlight: Highlight): boolean {
  return highlight.components.size + highlight.connections.size + highlight.steps.size > 0;
}

function FindingCard({
  check,
  analysis,
  compact = false,
}: {
  readonly check: CheckResult;
  readonly analysis: Analysis;
  readonly compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(!compact);
  const pinned = useUi((s) => s.pinned?.key === check.instance.id);
  const { setHover, togglePin } = useUi.getState();
  const highlight =
    check.evidence.length > 0 ? highlightFromEvidence(check.evidence, analysis) : null;
  const ok = check.status === "pass";
  const Icon = ok
    ? CircleCheck
    : check.gateFailed
      ? ShieldAlert
      : check.instance.severity === "minor"
        ? TriangleAlert
        : CircleX;
  const tone = ok
    ? "text-emerald-600"
    : check.gateFailed || check.instance.severity === "critical"
      ? "text-rose-600"
      : "text-amber-600";

  return (
    <article
      className={`rounded-md border bg-white ${pinned ? "border-amber-400" : "border-zinc-200"}`}
      onMouseEnter={() => highlight && setHover(highlight)}
      onMouseLeave={() => setHover(null)}
      onFocus={() => highlight && setHover(highlight)}
      onBlur={() => setHover(null)}
    >
      <header className="flex items-start gap-2 px-3 py-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} aria-hidden="true" />
        <button
          type="button"
          className="flex-1 text-left"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          <span className="text-sm font-medium text-zinc-900">{check.instance.title}</span>
          <span className="ml-2 inline-flex gap-1 align-middle">
            {check.gateFailed && <Tag className="bg-rose-100 text-rose-800">gate</Tag>}
            {!ok && <Tag className="bg-zinc-100 text-zinc-700">{check.instance.severity}</Tag>}
            {check.instance.signal !== "baseline" && (
              <Tag className="bg-violet-100 text-violet-800">{check.instance.signal} signal</Tag>
            )}
            {check.instance.requirements.map((r) => (
              <Tag key={r} className="bg-sky-50 text-sky-800">
                {r}
              </Tag>
            ))}
          </span>
          <p className="mt-0.5 text-sm text-zinc-700">{check.message}</p>
        </button>
        {highlight && (
          <button
            type="button"
            onClick={() => {
              togglePin(check.instance.id, highlight);
              // Trade-offs live under Decisions, not on the canvas.
              if (!pinned && highlight.decisions.size > 0)
                useUi.getState().setRightTab("decisions");
            }}
            aria-pressed={pinned}
            aria-label={onCanvas(highlight) ? "Show on canvas" : "Show under Decisions"}
            title={onCanvas(highlight) ? "Show on canvas" : "Show under Decisions"}
            className={`rounded p-1 ${pinned ? "bg-amber-100 text-amber-900" : "text-zinc-500 hover:bg-zinc-100"}`}
          >
            <Crosshair className="h-4 w-4" />
          </button>
        )}
      </header>
      {expanded && (
        <div className="flex flex-col gap-2 border-t border-zinc-100 px-3 py-2 text-sm">
          {check.details.length > 0 && (
            <ul className="font-mono text-xs text-zinc-700">
              {check.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <p className="text-zinc-700">
            <span className="font-semibold text-zinc-900">Why it matters. </span>
            {check.instance.why}
          </p>
          {!ok && (
            <p className="text-zinc-700">
              <span className="font-semibold text-zinc-900">How to fix. </span>
              {check.instance.fix}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function Tag({
  className,
  children,
}: {
  readonly className: string;
  readonly children: React.ReactNode;
}) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${className}`}>{children}</span>
  );
}

function Group({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1 self-start text-xs font-semibold text-zinc-600 hover:text-zinc-900"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
          aria-hidden="true"
        />
        {title}
      </button>
      {open && children}
    </section>
  );
}
