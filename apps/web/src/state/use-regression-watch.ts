import { useEffect } from "react";
import { useEvaluation } from "./evaluation";
import { describeRegression, describeRegressions, useRegressions } from "./regressions";
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
  const lastChange = useAttemptStore((s) => s.lastChange);
  const current = useUi((s) => s.scenarioId);
  useEffect(() => {
    const added = useRegressions
      .getState()
      .observe(evaluation, generation, useUi.getState().scenarioId, lastChange === "history");
    const [first] = added;
    if (added.length === 1 && first) {
      useToasts.getState().notify(describeRegression(...first));
    } else if (added.length > 1) {
      useToasts.getState().notify(describeRegressions(added));
    }
  }, [evaluation, generation, lastChange]);
  useEffect(() => {
    useRegressions.getState().acknowledge(current);
  }, [current]);
}
