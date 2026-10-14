import { ChevronDown, ChevronUp, Circle, CircleCheck, X } from "lucide-react";
import { useMemo, useState } from "react";
import { activePack, catalogIndex } from "../../state/content";
import { useEvaluation } from "../../state/evaluation";
import { guideFor } from "../../state/guide";
import { useOnboarding } from "../../state/onboarding";
import { useAttemptStore } from "../../state/store";
import { useUi } from "../../state/ui-store";
import { Button, IconButton } from "../../ui/primitives";
import { showMe } from "./actions";

/** The getting-started checklist, ticking itself off as the design takes shape. */
export function GuideCard() {
  const attempt = useAttemptStore((s) => s.attempt);
  const scenarioId = useUi((s) => s.scenarioId);
  const { scenarios } = useEvaluation();
  const scenario = activePack.scenarios.find((s) => s.id === scenarioId);
  const result = scenarios.find((s) => s.scenarioId === scenarioId);
  const guide = useMemo(
    () => guideFor(attempt, scenario, activePack.problem.operations, result, catalogIndex),
    [attempt, scenario, result],
  );
  const done = guide.steps.filter((s) => s.done).length;
  // Compact by default: the current step only, so the card covers little of the canvas.
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? guide.steps : guide.steps.filter((s) => s.id === guide.current);
  return (
    <section
      aria-label="Getting started"
      data-canvas-overlay
      className="w-72 rounded-xl border border-line bg-elevated p-3 shadow-pop"
    >
      <header className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-fg">Getting started</h2>
        <span className="text-xs text-fg-subtle tabular-nums">
          {done}/{guide.steps.length}
        </span>
        <IconButton
          className="ml-auto h-7 w-7"
          aria-label={expanded ? "Show only the current step" : "Show every step"}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </IconButton>
        <IconButton
          className="h-7 w-7"
          aria-label="Close the guide"
          title="Close the guide (reopen it from the help menu)"
          onClick={() => useOnboarding.getState().setGuideOpen(false)}
        >
          <X className="h-4 w-4" />
        </IconButton>
      </header>
      <p className="mb-2 text-xs text-fg-muted">
        S{scenario?.order} {scenario?.title}
        {guide.operation ? ` · ${guide.operation.label}` : ""}
      </p>
      <span className="mb-3 block h-1 overflow-hidden rounded-full bg-track" aria-hidden="true">
        <span
          className="block h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${(100 * done) / guide.steps.length}%` }}
        />
      </span>
      <ol className="flex flex-col gap-1">
        {shown.map((step) => {
          const current = step.id === guide.current;
          return (
            <li
              key={step.id}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] ${
                current ? "bg-accent-soft" : ""
              }`}
            >
              {step.done ? (
                <CircleCheck className="h-4 w-4 shrink-0 text-ok" aria-label="done" />
              ) : (
                <Circle
                  className={`h-4 w-4 shrink-0 ${current ? "text-accent" : "text-fg-faint"}`}
                  aria-label="to do"
                />
              )}
              <span
                className={
                  step.done
                    ? "text-fg-subtle line-through"
                    : current
                      ? "font-medium text-fg"
                      : "text-fg-muted"
                }
              >
                {step.title}
              </span>
              {current && (
                <Button
                  size="sm"
                  variant="primary"
                  className="ml-auto"
                  onClick={() => showMe(step.id, guide)}
                >
                  Show me
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      {guide.current === null && (
        <p className="mt-2 text-xs text-fg-muted">
          This scenario is evaluated. Try the next one from the steps at the top, or improve the
          score with the findings.
        </p>
      )}
    </section>
  );
}
