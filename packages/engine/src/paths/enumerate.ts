import { type Attempt, type Flow, feasibleOutcomes, type IngressRoute } from "@archdrill/model";
import type { Path, PathStep, PathTerminal } from "./types";

/** Hard cap that protects the UI from pathological flows. */
export const MAX_PATHS_PER_OPERATION = 2000;

export interface EnumerationResult {
  readonly paths: Path[];
  readonly truncated: boolean;
}

/**
 * Expands a flow DAG into every root-to-terminal path, choosing one outcome at
 * each branching step. Order is deterministic: depth-first, outcomes in the
 * order their action or logic declares them.
 *
 * The flow must be structurally valid (root present, no cycles, no dangling
 * links); validation guarantees that before analysis calls this.
 */
export function enumeratePaths(
  flow: Flow,
  attempt: Attempt,
  ingress: IngressRoute | null,
): EnumerationResult {
  const paths: Path[] = [];
  if (flow.root === null) return { paths, truncated: false };

  const connectionTo = new Map(
    attempt.architecture.connections
      .filter((c) => c.from === flow.handler)
      .map((c) => [c.to, c.id] as const),
  );
  let truncated = false;

  const emit = (steps: PathStep[], terminal: PathTerminal) => {
    if (paths.length >= MAX_PATHS_PER_OPERATION) {
      truncated = true;
      return;
    }
    const index = paths.length;
    paths.push({
      id: `${flow.operation}#${index}`,
      operation: flow.operation,
      index,
      steps,
      terminal,
      ...touched(steps, ingress),
    });
  };

  const walk = (stepId: string, trail: PathStep[]) => {
    if (truncated) return;
    const step = flow.steps[stepId];
    if (!step) return;
    if (step.type === "respond") {
      emit(trail, { kind: "respond", stepId, status: step.status });
      return;
    }
    for (const outcome of feasibleOutcomes(step, attempt)) {
      const pathStep: PathStep =
        step.type === "call"
          ? {
              kind: "call",
              stepId,
              target: step.target,
              targetKind:
                attempt.architecture.components.find((c) => c.id === step.target)?.kind ?? "",
              connectionId: connectionTo.get(step.target) ?? null,
              action: step.action,
              entity: step.entity,
              ttlSec: step.ttlSec,
              batchSize: step.batchSize,
              event: step.event,
              ...(step.coalesce === undefined ? {} : { coalesce: step.coalesce }),
              ...(step.consistent === undefined ? {} : { consistent: step.consistent }),
              ...(step.aggregateSec === undefined ? {} : { aggregateSec: step.aggregateSec }),
              ...(step.counterShards === undefined ? {} : { counterShards: step.counterShards }),
              ...(step.fireAndForget === undefined ? {} : { fireAndForget: step.fireAndForget }),
              ...(step.bufferSize === undefined ? {} : { bufferSize: step.bufferSize }),
              ...(step.each === undefined ? {} : { each: step.each }),
              ...(step.idempotencyKey === undefined ? {} : { idempotencyKey: step.idempotencyKey }),
              ...(step.outbox === undefined ? {} : { outbox: step.outbox }),
              ...(step.exactlyOnce === undefined ? {} : { exactlyOnce: step.exactlyOnce }),
              outcome,
            }
          : { kind: "logic", stepId, logic: step.logic, outcome };
      const next = step.next[outcome];
      const extended = [...trail, pathStep];
      if (next === undefined) emit(extended, { kind: "unhandled", stepId, outcome });
      else walk(next, extended);
    }
  };

  walk(flow.root, []);
  return { paths, truncated };
}

function touched(
  steps: readonly PathStep[],
  ingress: IngressRoute | null,
): { components: string[]; connections: string[] } {
  const components = [...(ingress?.components ?? [])];
  const connections = [...(ingress?.connections ?? [])];
  for (const step of steps) {
    if (step.kind !== "call") continue;
    if (!components.includes(step.target)) components.push(step.target);
    if (step.connectionId !== null && !connections.includes(step.connectionId)) {
      connections.push(step.connectionId);
    }
  }
  return { components, connections };
}
