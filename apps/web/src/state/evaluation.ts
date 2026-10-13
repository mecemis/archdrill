import type { Analysis, EnvironmentMetrics, OperationAnalysis } from "@archdrill/engine";
import { type AttemptEvaluation, type Evidence, evaluateAttempt } from "@archdrill/evaluator";
import type { Attempt } from "@archdrill/model";
import { create } from "zustand";
import { activePack, catalogIndex } from "./content";
import { createWorkerClient, type EvaluationReply } from "./evaluation-client";
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

interface EvaluationState {
  /** The newest evaluation the worker returned, and the version of the design it belongs to. */
  readonly latest: { readonly attempt: Attempt; readonly evaluation: AttemptEvaluation } | null;
  /** True while the results shown belong to an older version of the design. */
  readonly pending: boolean;
  /** How long the worker took for the latest evaluation. */
  readonly durationMs: number | null;
}

export const useEvaluationStore = create<EvaluationState>(() => ({
  latest: null,
  pending: false,
  durationMs: null,
}));

function accept(attempt: Attempt, reply: EvaluationReply): void {
  let evaluation: AttemptEvaluation;
  if (reply.error === undefined) {
    evaluation = reply.evaluation;
  } else {
    // Results must never go silently stale: evaluate on the main thread instead.
    console.error(`Evaluation failed in the worker: ${reply.error}`);
    evaluation = evaluate(attempt);
  }
  useEvaluationStore.setState({
    latest: { attempt, evaluation },
    pending: !sameEvaluationInputs(attempt, useAttemptStore.getState().attempt),
    durationMs: reply.error === undefined ? reply.durationMs : null,
  });
}

/**
 * Edits are evaluated in a worker, so the canvas never waits for the
 * simulation; until a new result arrives, the previous one stays on screen,
 * marked as updating. Where workers are missing (tests), evaluation runs
 * synchronously on render.
 */
const client = createWorkerClient(accept);

if (client) {
  const initial = useAttemptStore.getState().attempt;
  useEvaluationStore.setState({ latest: { attempt: initial, evaluation: evaluate(initial) } });
  useAttemptStore.subscribe((state, previous) => {
    if (state.attempt === previous.attempt) return;
    const latest = useEvaluationStore.getState().latest;
    if (latest && sameEvaluationInputs(latest.attempt, state.attempt)) {
      useEvaluationStore.setState({ pending: false });
      return;
    }
    useEvaluationStore.setState({ pending: true });
    client.request(state.attempt);
  });
}

export function useEvaluation(): AttemptEvaluation {
  const attempt = useAttemptStore((s) => s.attempt);
  const latest = useEvaluationStore((s) => s.latest);
  return latest?.evaluation ?? evaluate(attempt);
}

/** Whether the results on screen are about to be replaced by those of a newer edit. */
export function useEvaluationPending(): boolean {
  return useEvaluationStore((s) => s.pending);
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
