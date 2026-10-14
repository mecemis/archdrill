import type { ScenarioResult } from "@archdrill/evaluator";
import { Monitor, Moon, Redo2, RotateCcw, Sun, Undo2 } from "lucide-react";
import { useState } from "react";
import { starterAttempt } from "../state/attempt-store";
import { activePack, openProblem, problemChoices } from "../state/content";
import { useEvaluation } from "../state/evaluation";
import { describeRegression, useRegressions } from "../state/regressions";
import { useAttemptStore } from "../state/store";
import { NEXT_CHOICE, type ThemeChoice, useTheme } from "../state/theme";
import { useUi } from "../state/ui-store";
import { Button, FOCUS_RING, IconButton, Select } from "../ui/primitives";
import { ExchangeButtons } from "./ExchangeButtons";

/** Status dot colour for a scenario's result. */
function dotClass(result: ScenarioResult | undefined): string {
  if (result?.status !== "evaluated") return "bg-fg-faint";
  switch (result.scorecard.band) {
    case "excellent":
      return "bg-ok";
    case "strong":
      return "bg-info";
    case "passing":
      return "bg-warn";
    default:
      return "bg-bad";
  }
}

function statusText(result: ScenarioResult | undefined): string {
  if (result?.status !== "evaluated") return "not evaluated yet";
  const { score, band } = result.scorecard;
  return `${score}, ${band === "not-passing" ? "not passing yet" : band}`;
}

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon } as const;
const THEME_LABELS: Readonly<Record<ThemeChoice, string>> = {
  system: "Theme: follows the system",
  light: "Theme: light",
  dark: "Theme: dark",
};

function ThemeToggle() {
  const choice = useTheme((s) => s.choice);
  const setChoice = useTheme((s) => s.setChoice);
  const Icon = THEME_ICONS[choice];
  return (
    <IconButton
      aria-label={THEME_LABELS[choice]}
      title={`${THEME_LABELS[choice]} (click to change)`}
      onClick={() => setChoice(NEXT_CHOICE[choice])}
    >
      <Icon className="h-4 w-4" />
    </IconButton>
  );
}

function Logo() {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span
        className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-[13px] font-bold text-on-accent shadow-card"
        aria-hidden="true"
      >
        A
      </span>
      <h1 className="text-[15px] font-semibold tracking-tight text-fg">ArchDrill</h1>
    </span>
  );
}

function ScenarioSteps() {
  const { scenarios } = useEvaluation();
  const scenarioId = useUi((s) => s.scenarioId);
  const setScenario = useUi((s) => s.setScenario);
  const regressions = useRegressions((s) => s.regressions);
  return (
    <nav aria-label="Scenarios" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {activePack.scenarios.map((scenario) => {
        const result = scenarios.find((r) => r.scenarioId === scenario.id);
        const passing = result?.status === "evaluated" && result.scorecard.band !== "not-passing";
        const regression = regressions[scenario.id];
        const current = scenario.id === scenarioId;
        const status = statusText(result);
        return (
          <button
            key={scenario.id}
            type="button"
            onClick={() => setScenario(scenario.id)}
            aria-current={current ? "step" : undefined}
            title={
              regression
                ? describeRegression(scenario.id, regression)
                : `S${scenario.order} ${scenario.title}: ${status}`
            }
            className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors ${FOCUS_RING} ${
              current
                ? "bg-accent-soft text-accent-fg ring-1 ring-accent-line"
                : "text-fg-muted hover:bg-muted hover:text-fg"
            }`}
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${dotClass(result)}`}
              aria-hidden="true"
            />
            <span className="sr-only">{passing ? "(passing)" : "(not passing yet)"}</span>S
            {scenario.order}{" "}
            <span className={current ? "max-w-[18rem] truncate" : "sr-only"}>{scenario.title}</span>
            {regression && (
              <span className="rounded bg-bad-soft px-1 text-[11px] font-semibold text-bad-fg">
                ↓{regression.from - regression.to}
                <span className="sr-only"> points since your last change</span>
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

export function Header() {
  const canUndo = useAttemptStore((s) => s.past.length > 0);
  const canRedo = useAttemptStore((s) => s.future.length > 0);
  const { undo, redo, replace } = useAttemptStore.getState();
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <header className="flex h-14 items-center gap-3 border-b border-line bg-surface px-3">
      <Logo />
      <span className="h-6 w-px shrink-0 bg-line" aria-hidden="true" />
      {problemChoices.length > 1 ? (
        <Select
          aria-label="Problem"
          value={activePack.problem.id}
          onChange={(e) => openProblem(e.target.value)}
          className="w-52 shrink-0"
        >
          {problemChoices.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </Select>
      ) : (
        <span className="shrink-0 text-sm font-medium text-fg-muted">
          {activePack.problem.title}
        </span>
      )}
      <ScenarioSteps />
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <ExchangeButtons />
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <IconButton onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (Ctrl/Cmd+Z)">
          <Undo2 className="h-4 w-4" />
        </IconButton>
        <IconButton
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo (Shift+Ctrl/Cmd+Z)"
        >
          <Redo2 className="h-4 w-4" />
        </IconButton>
        <ThemeToggle />
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        {confirmReset ? (
          <>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                replace(starterAttempt(activePack.problem), {
                  undoable: true,
                });
                useUi.getState().select(null);
                useUi.getState().armSlot(null);
                setConfirmReset(false);
              }}
            >
              Discard design
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmReset(true)}
            title="Start over"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>
        )}
      </div>
    </header>
  );
}
