import type { Analysis, EnvironmentMetrics, OperationAnalysis } from "@archdrill/engine";
import { type AttemptEvaluation, type Evidence, evaluateAttempt } from "@archdrill/evaluator";
import type { Attempt } from "@archdrill/model";
import { activePack, catalogIndex } from "./content";
import { useAttemptStore } from "./store";
import { type Highlight, useUi } from "./ui-store";

let cached: { readonly attempt: Attempt; readonly evaluation: AttemptEvaluation } | undefined;

/** Evaluation never reads the layout, so moving nodes must not trigger a re-run. */
function sameEvaluationInputs(a: Attempt, b: Attempt): boolean {
  return a.architecture === b.architecture && a.flows === b.flows && a.decisions === b.decisions;
}

/**
 * Evaluates every scenario once per version of the evaluated parts of the
 * attempt. Attempts are immutable with structural sharing, so reference
 * equality is a safe cache key and every component sees the same result.
 */
export function evaluate(attempt: Attempt): AttemptEvaluation {
  if (!cached || !sameEvaluationInputs(cached.attempt, attempt)) {
    cached = {
      attempt,
      evaluation: evaluateAttempt(attempt, { ...activePack, catalog: catalogIndex }),
    };
  }
  return cached.evaluation;
}

export function useEvaluation(): AttemptEvaluation {
  return evaluate(useAttemptStore((s) => s.attempt));
}

export function highlightFromEvidence(
  evidence: readonly Evidence[],
  analysis: Analysis,
): Highlight {
  const components = new Set<string>();
  const connections = new Set<string>();
  const steps = new Set<string>();
  for (const item of evidence) {
    if (item.type === "component") components.add(item.componentId);
    if (item.type === "connection") connections.add(item.connectionId);
    if (item.type === "step") steps.add(item.stepId);
    if (item.type === "path") {
      const path = analysis.operations.get(item.operation)?.paths.find((p) => p.id === item.pathId);
      if (!path) continue;
      for (const id of path.components) components.add(id);
      for (const id of path.connections) connections.add(id);
      for (const step of path.steps) steps.add(step.stepId);
    }
  }
  return { components, connections, steps };
}

export function highlightFromPath(op: OperationAnalysis, pathId: string): Highlight {
  const path = op.paths.find((p) => p.id === pathId);
  return {
    components: new Set(path?.components ?? []),
    connections: new Set(path?.connections ?? []),
    steps: new Set(path?.steps.map((s) => s.stepId) ?? []),
  };
}

export interface ScenarioLoad {
  /** Environments the active scenario simulates, lightest first. */
  readonly environments: readonly { readonly id: string; readonly label: string }[];
  readonly environmentId: string | null;
  /** Metrics of the selected environment, or undefined when the scenario has no workload or is not evaluated. */
  readonly metrics: EnvironmentMetrics | undefined;
}

/** Simulated load of the selected environment of the active scenario. */
export function useScenarioLoad(): ScenarioLoad {
  const { scenarios } = useEvaluation();
  const scenarioId = useUi((s) => s.scenarioId);
  const selected = useUi((s) => s.environmentId);
  const workload = activePack.scenarios.find((s) => s.id === scenarioId)?.workload;
  const environments = workload?.environments.map((e) => ({ id: e.id, label: e.label })) ?? [];
  const environmentId =
    selected && environments.some((e) => e.id === selected)
      ? selected
      : (environments.at(-1)?.id ?? null);
  const result = scenarios.find((s) => s.scenarioId === scenarioId);
  const metrics =
    result?.status === "evaluated" && environmentId ? result.metrics.get(environmentId) : undefined;
  return { environments, environmentId, metrics };
}
