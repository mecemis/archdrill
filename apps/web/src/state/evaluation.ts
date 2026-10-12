import type { Analysis, OperationAnalysis } from "@archdrill/engine";
import { type AttemptEvaluation, type Evidence, evaluateAttempt } from "@archdrill/evaluator";
import { useMemo } from "react";
import { activePack, catalogIndex } from "./content";
import { useAttemptStore } from "./store";
import type { Highlight } from "./ui-store";

/** Evaluates every scenario of the active problem whenever the attempt changes. */
export function useEvaluation(): AttemptEvaluation {
  const attempt = useAttemptStore((s) => s.attempt);
  return useMemo(
    () => evaluateAttempt(attempt, { ...activePack, catalog: catalogIndex }),
    [attempt],
  );
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
