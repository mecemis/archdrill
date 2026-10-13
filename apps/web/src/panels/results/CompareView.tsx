import type { ScenarioResult } from "@archdrill/evaluator";
import { describeChanges } from "@archdrill/model";
import { Pin, RotateCcw, X } from "lucide-react";
import { useBaseline } from "../../state/baseline";
import { activePack } from "../../state/content";
import { useEvaluation } from "../../state/evaluation";
import { useAttemptStore } from "../../state/store";
import { Button } from "../../ui/primitives";

const scoreOf = (result: ScenarioResult | undefined) =>
  result?.status === "evaluated" ? result.scorecard.score : null;

/** Scores and design changes since a pinned baseline, across every scenario. */
export function CompareView() {
  const attempt = useAttemptStore((s) => s.attempt);
  const { baseline, evaluation, pin, clear } = useBaseline();
  const current = useEvaluation();
  if (!baseline || !evaluation) {
    return (
      <div className="flex flex-col items-start gap-2 p-3 text-sm text-zinc-600">
        <p>
          Pin the current design as a baseline, then change it: this view shows how every scenario's
          score moved and what you changed.
        </p>
        <Button onClick={() => pin(attempt)}>
          <Pin className="h-4 w-4" />
          Pin as baseline
        </Button>
      </div>
    );
  }
  const changes = describeChanges(baseline, attempt);
  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => pin(attempt)}>
          <Pin className="h-4 w-4" />
          Pin current design
        </Button>
        <Button
          variant="ghost"
          onClick={() => useAttemptStore.getState().replace(baseline, { undoable: true })}
          title="Go back to the baseline design"
        >
          <RotateCcw className="h-4 w-4" />
          Restore baseline
        </Button>
        <Button variant="ghost" onClick={clear}>
          <X className="h-4 w-4" />
          Clear
        </Button>
      </div>
      <table className="w-full max-w-xl text-left">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="font-medium">Scenario</th>
            <th className="font-medium">Baseline</th>
            <th className="font-medium">Now</th>
            <th className="font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          {activePack.scenarios.map((scenario) => {
            const before = scoreOf(evaluation.scenarios.find((s) => s.scenarioId === scenario.id));
            const after = scoreOf(current.scenarios.find((s) => s.scenarioId === scenario.id));
            const delta = before !== null && after !== null ? after - before : null;
            return (
              <tr key={scenario.id} className="tabular-nums">
                <td className="py-0.5">
                  S{scenario.order} {scenario.title}
                </td>
                <td>{before ?? "–"}</td>
                <td>{after ?? "–"}</td>
                <td
                  className={
                    delta === null || delta === 0
                      ? "text-zinc-500"
                      : delta > 0
                        ? "font-semibold text-emerald-700"
                        : "font-semibold text-rose-700"
                  }
                >
                  {delta === null ? "–" : delta > 0 ? `+${delta}` : delta}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <section>
        <h4 className="mb-1 text-xs font-semibold text-zinc-600">What changed</h4>
        {changes.length === 0 ? (
          <p className="text-zinc-500">Nothing yet.</p>
        ) : (
          <ul className="list-disc pl-5 text-zinc-700">
            {changes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
