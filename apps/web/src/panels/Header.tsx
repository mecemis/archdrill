import { Redo2, RotateCcw, Undo2 } from "lucide-react";
import { useState } from "react";
import { starterAttempt } from "../state/attempt-store";
import { activePack } from "../state/content";
import { useEvaluation } from "../state/evaluation";
import { useAttemptStore } from "../state/store";
import { useUi } from "../state/ui-store";
import { Button } from "../ui/primitives";

export function Header() {
  const { scenarios } = useEvaluation();
  const scenarioId = useUi((s) => s.scenarioId);
  const setScenario = useUi((s) => s.setScenario);
  const canUndo = useAttemptStore((s) => s.past.length > 0);
  const canRedo = useAttemptStore((s) => s.future.length > 0);
  const { undo, redo, replace } = useAttemptStore.getState();
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <header className="flex h-12 items-center gap-4 border-b border-zinc-200 bg-white px-4">
      <h1 className="text-sm font-semibold tracking-tight text-zinc-900">
        ArchDrill <span className="font-normal text-zinc-500">· {activePack.problem.title}</span>
      </h1>
      <nav aria-label="Scenarios" className="flex gap-1">
        {activePack.scenarios.map((scenario) => {
          const result = scenarios.find((r) => r.scenarioId === scenario.id);
          const passing = result?.status === "evaluated" && result.scorecard.band !== "not-passing";
          return (
            <button
              key={scenario.id}
              type="button"
              onClick={() => setScenario(scenario.id)}
              aria-current={scenario.id === scenarioId ? "step" : undefined}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ${
                scenario.id === scenarioId
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-700 hover:bg-zinc-100"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${passing ? "bg-emerald-500" : "bg-zinc-300"}`}
                aria-hidden="true"
              />
              <span className="sr-only">{passing ? "(passing)" : "(not passing yet)"}</span>S
              {scenario.order} {scenario.title}
            </button>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          onClick={undo}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo (Ctrl/Cmd+Z)"
        >
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo (Shift+Ctrl/Cmd+Z)"
        >
          <Redo2 className="h-4 w-4" />
        </Button>
        {confirmReset ? (
          <>
            <Button
              variant="danger"
              onClick={() => {
                replace(starterAttempt(activePack.problem.id, activePack.problem.version));
                useUi.getState().select(null);
                setConfirmReset(false);
              }}
            >
              Discard design
            </Button>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmReset(true)} title="Start over">
            <RotateCcw className="h-4 w-4" />
            Reset
          </Button>
        )}
      </div>
    </header>
  );
}
