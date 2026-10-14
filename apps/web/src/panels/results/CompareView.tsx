import type { ScenarioResult } from "@archdrill/evaluator";
import { describeChanges, importAttempt } from "@archdrill/model";
import { FileUp, Pin, RotateCcw, X } from "lucide-react";
import { useRef } from "react";
import { useBaseline } from "../../state/baseline";
import { activePack } from "../../state/content";
import { useEvaluation } from "../../state/evaluation";
import { useAttemptStore } from "../../state/store";
import { useToasts } from "../../state/toasts";
import { usd } from "../../ui/format";
import { Button } from "../../ui/primitives";

const scoreOf = (result: ScenarioResult | undefined) =>
  result?.status === "evaluated" ? result.scorecard.score : null;

/** The most a scenario's environments would cost a month, if sustained. */
const costOf = (result: ScenarioResult | undefined) =>
  result?.status === "evaluated" && result.metrics.size > 0
    ? Math.max(...[...result.metrics.values()].map((m) => m.monthlyCost))
    : null;

/** Loads a design file as the design to compare with, keeping the current one. */
function CompareFile() {
  const input = useRef<HTMLInputElement>(null);
  const notify = useToasts((s) => s.notify);
  const load = async (file: File) => {
    try {
      const attempt = importAttempt(await file.text());
      if (attempt.problemId !== activePack.problem.id) {
        notify(`That design is for another problem (${attempt.problemId}).`, "error");
        return;
      }
      // Throws, before anything is stored, when the design cannot be evaluated.
      useBaseline.getState().pin(attempt, file.name);
    } catch (error) {
      notify(error instanceof Error ? error.message : "The file could not be read.", "error");
    }
  };
  return (
    <>
      <Button variant="ghost" onClick={() => input.current?.click()}>
        <FileUp className="h-4 w-4" />
        Compare with a design file
      </Button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-label="Design to compare with"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void load(file);
        }}
      />
    </>
  );
}

/** Scores and design changes since a pinned baseline, across every scenario. */
export function CompareView() {
  const attempt = useAttemptStore((s) => s.attempt);
  const { baseline, evaluation, source, pin, clear } = useBaseline();
  const current = useEvaluation();
  if (!baseline || !evaluation) {
    return (
      <div className="flex flex-col items-start gap-2 p-3 text-sm text-zinc-600">
        <p>
          Pin the current design as a baseline, then change it, or load another design from a file:
          this view runs both through every scenario and shows how scores and costs differ, and what
          changed.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => pin(attempt)}>
            <Pin className="h-4 w-4" />
            Pin as baseline
          </Button>
          <CompareFile />
        </div>
      </div>
    );
  }
  const changes = describeChanges(baseline, attempt);
  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <p className="text-xs text-zinc-500" data-testid="compare-source">
        Comparing with {source ? source : "the pinned design"}.
      </p>
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
        <CompareFile />
        <Button variant="ghost" onClick={clear}>
          <X className="h-4 w-4" />
          Clear
        </Button>
      </div>
      <table className="w-full max-w-3xl text-left">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="font-medium">Scenario</th>
            <th className="font-medium">Baseline</th>
            <th className="font-medium">Now</th>
            <th className="font-medium">Change</th>
            <th className="font-medium">Cost then</th>
            <th className="font-medium">Cost now</th>
          </tr>
        </thead>
        <tbody>
          {activePack.scenarios.map((scenario) => {
            const before = scoreOf(evaluation.scenarios.find((s) => s.scenarioId === scenario.id));
            const after = scoreOf(current.scenarios.find((s) => s.scenarioId === scenario.id));
            const delta = before !== null && after !== null ? after - before : null;
            const costThen = costOf(evaluation.scenarios.find((s) => s.scenarioId === scenario.id));
            const costNow = costOf(current.scenarios.find((s) => s.scenarioId === scenario.id));
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
                <td>{costThen === null ? "–" : usd(costThen)}</td>
                <td>{costNow === null ? "–" : usd(costNow)}</td>
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
