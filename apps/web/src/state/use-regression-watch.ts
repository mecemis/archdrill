import { useEffect } from "react";
import { useEvaluation } from "./evaluation";
import { describeRegression, useRegressions } from "./regressions";
import { useAttemptStore } from "./store";
import { useToasts } from "./toasts";
import { useUi } from "./ui-store";

/**
 * Tells the candidate when a change lowers another scenario's score, since
 * every scenario shares one design; looking at that scenario clears the mark.
 */
export function useRegressionWatch(): void {
  const evaluation = useEvaluation();
  const generation = useAttemptStore((s) => s.generation);
  const current = useUi((s) => s.scenarioId);
  useEffect(() => {
    const added = useRegressions
      .getState()
      .observe(evaluation, generation, useUi.getState().scenarioId);
    for (const [id, regression] of added) {
      useToasts.getState().notify(describeRegression(id, regression));
    }
  }, [evaluation, generation]);
  useEffect(() => {
    useRegressions.getState().acknowledge(current);
  }, [current]);
}
