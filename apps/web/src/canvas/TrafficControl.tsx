import { Panel } from "@xyflow/react";
import { Gauge, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { componentLabel } from "../panels/flow/step-label";
import { activePack } from "../state/content";
import { useScenarioLoad } from "../state/evaluation";
import { useAttemptStore } from "../state/store";
import { useUi } from "../state/ui-store";
import {
  findBreakingPoint,
  MAX_FACTOR,
  MIN_FACTOR,
  useBreakingPoint,
  useWhatIf,
} from "../state/what-if";
import { factorLabel } from "../state/what-if-compute";
import { compact, percent } from "../ui/format";
import { FOCUS_RING, IconButton } from "../ui/primitives";

/** Multiples one click away. */
const PRESETS = [0.5, 1, 2, 5, 10] as const;
/** Slider steps per doubling, on a logarithmic scale. */
const STEPS_PER_DOUBLING = 8;

const toSlider = (factor: number) => Math.round(Math.log2(factor) * STEPS_PER_DOUBLING);
const fromSlider = (value: number) => 2 ** (value / STEPS_PER_DOUBLING);

/** The users' traffic of the shown environment, multiplied to see what the design does with more. */
export function TrafficControl() {
  const factor = useWhatIf((s) => s.factor);
  const scenarioId = useUi((s) => s.scenarioId);
  const { environmentId, environments } = useScenarioLoad();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const environment = activePack.scenarios
    .find((s) => s.id === scenarioId)
    ?.workload?.environments.find((e) => e.id === environmentId);
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  // Escape closes the panel, before anything else that listens for it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      setOpen(false);
      toggle.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);
  if (!environment) return null;
  const label = environments.find((e) => e.id === environmentId)?.label ?? environment.label;
  const requests = activePack.problem.operations.filter(
    (o) => o.trigger.type === "request" && (environment.rates[o.id] ?? 0) > 0,
  );
  return (
    <div className="relative">
      <button
        ref={toggle}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Traffic: ${factorLabel(factor)} ${label}`}
        title="Multiply the traffic to see what the design does with more"
        onClick={() => setOpen((on) => !on)}
        className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold shadow-card ${FOCUS_RING} ${
          factor === 1
            ? "border-line bg-elevated text-fg-muted"
            : "border-warn-line bg-warn-soft text-warn-fg"
        }`}
      >
        <Gauge className="h-4 w-4" aria-hidden="true" />
        {factorLabel(factor)}
      </button>
      {open && (
        <section
          id={panelId}
          aria-label="Traffic"
          className="absolute top-full right-0 z-20 mt-1.5 flex w-80 flex-col gap-2.5 rounded-xl border border-line bg-elevated p-3 text-sm shadow-pop"
          data-testid="traffic-control"
        >
          <header className="flex items-center gap-2">
            <h4 className="font-semibold">Traffic of {label}</h4>
            <IconButton className="ml-auto h-6 w-6" aria-label="Close" onClick={close}>
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </header>
          <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
            {requests.map((o) => (
              <li key={o.id} className="flex justify-between tabular-nums">
                <span>{o.label}</span>
                <span className="text-fg">
                  {compact((environment.rates[o.id] ?? 0) * factor)}/s
                </span>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <input
              type="range"
              min={toSlider(MIN_FACTOR)}
              max={toSlider(MAX_FACTOR)}
              step={1}
              value={toSlider(factor)}
              aria-label="Traffic multiple"
              aria-valuetext={factorLabel(factor)}
              onChange={(e) => useWhatIf.getState().setFactor(fromSlider(Number(e.target.value)))}
              className="flex-1 accent-[var(--accent)]"
            />
            <span className="w-10 text-right font-semibold text-fg tabular-nums">
              {factorLabel(factor)}
            </span>
          </label>
          <div className="flex gap-1">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-pressed={preset === factor}
                onClick={() => useWhatIf.getState().setFactor(preset)}
                className={`flex-1 rounded-md border px-1.5 py-1 text-xs ${FOCUS_RING} ${
                  preset === factor
                    ? "border-accent bg-accent text-on-accent"
                    : "border-line text-fg-muted hover:text-fg"
                }`}
              >
                {factorLabel(preset)}
              </button>
            ))}
          </div>
          <BreakingPoint />
          <p className="text-[11px] text-fg-subtle">
            A what-if: the canvas and Load show it, while the scenario is still scored at its own
            traffic. Scheduled jobs keep their rate.
          </p>
        </section>
      )}
    </div>
  );
}

/** Where the design first breaks as the traffic grows, and a way to look at it there. */
function BreakingPoint() {
  const attempt = useAttemptStore((s) => s.attempt);
  const { point, found, searching } = useBreakingPoint();
  const operations = activePack.problem.operations;
  const opLabel = (id: string) => operations.find((o) => o.id === id)?.label ?? id;
  let answer: React.ReactNode = null;
  if (found && point === null) {
    answer = "The scenario has no load to grow here.";
  } else if (found && point) {
    if (point.factor === null) {
      answer = `It holds at every multiple tried, up to ${factorLabel(point.holds)}.`;
    } else {
      const { breakage } = point;
      const first = breakage?.overloaded[0];
      const failing = breakage?.failing[0];
      const behind = breakage?.behind[0];
      const limit = breakage?.limited[0];
      const unsettled = breakage?.unsettled ?? false;
      const route = (connectionId: string) => {
        const c = attempt.architecture.connections.find((x) => x.id === connectionId);
        return c
          ? `${componentLabel(attempt, c.from)} → ${componentLabel(attempt, c.to)}`
          : connectionId;
      };
      const limitText = limit
        ? limit.by === "bulkhead"
          ? `the bulkhead on ${route(limit.connectionId)} sheds ${percent(limit.share, 1)} of its calls`
          : limit.by === "pool"
            ? `${percent(limit.share, 1)} of the calls on ${route(limit.connectionId)} find no free connection`
            : `${percent(limit.share, 1)} of the calls on ${route(limit.connectionId)} time out`
        : "";
      const why = [
        first
          ? `${componentLabel(attempt, first.componentId)} is over capacity (${percent(first.utilization, first.utilization < 1.1 ? 1 : 0)})`
          : limitText,
        failing ? `${opLabel(failing.operation)} succeeds ${percent(failing.successRate, 2)}` : "",
        behind ? `${opLabel(behind)} falls behind` : "",
        unsettled ? "the load model no longer settles, so these numbers are approximate" : "",
      ]
        .filter(Boolean)
        .join("; ");
      answer = (
        <>
          {point.factor === 1 ? (
            <span>It already breaks at its own traffic: {why}.</span>
          ) : (
            <span>
              It breaks at about <strong>{factorLabel(point.factor)}</strong>: {why}.
            </span>
          )}{" "}
          {point.factor !== 1 && (
            <button
              type="button"
              onClick={() => useWhatIf.getState().setFactor(point.factor ?? 1)}
              className={`font-medium text-accent-fg underline ${FOCUS_RING}`}
            >
              Show it
            </button>
          )}
        </>
      );
    }
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-sunken p-2 text-xs">
      <button
        type="button"
        disabled={searching}
        onClick={findBreakingPoint}
        className={`self-start rounded-md bg-accent px-2.5 py-1 font-semibold text-on-accent disabled:opacity-60 ${FOCUS_RING}`}
      >
        {searching ? "Looking…" : "Find the breaking point"}
      </button>
      <p className="text-fg-muted empty:hidden" role="status" data-testid="breaking-point">
        {answer}
      </p>
    </div>
  );
}

/** Says, over the canvas, that the load shown is a what-if, and leads back. */
export function WhatIfBanner() {
  const { whatIf, environmentId, environments } = useScenarioLoad();
  if (!whatIf) return null;
  const label = environments.find((e) => e.id === environmentId)?.label ?? "";
  return (
    <Panel position="top-center">
      <p
        role="status"
        className="flex items-center gap-2 whitespace-nowrap rounded-xl border border-warn-line bg-elevated px-3 py-1.5 text-sm text-warn-fg shadow-pop"
        data-testid="what-if-banner"
      >
        What if: {factorLabel(whatIf.factor)} the traffic of {label}
        {whatIf.failed ? " (could not be simulated)" : whatIf.updating ? " (simulating…)" : ""}. Not
        scored.
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-xs font-medium underline hover:bg-warn-soft"
          onClick={() => useWhatIf.getState().setFactor(1)}
        >
          Back to {factorLabel(1)}
        </button>
      </p>
    </Panel>
  );
}
