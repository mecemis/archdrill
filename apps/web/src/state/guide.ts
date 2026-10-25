import type { ScenarioResult } from "@archdrill/evaluator";
import {
  type Attempt,
  type CatalogIndex,
  canHandle,
  findOperationRoute,
  type Operation,
  type Scenario,
} from "@archdrill/model";
import { openSlots } from "../panels/flow/add-step";

export type GuideStepId = "service" | "connect" | "flow" | "first-step" | "branches" | "score";

export interface GuideStep {
  readonly id: GuideStepId;
  readonly title: string;
  readonly done: boolean;
}

export interface Guide {
  /** The operation the steps are about: the first in focus that is not ready yet. */
  readonly operation: Operation | undefined;
  readonly steps: readonly GuideStep[];
  /** The first step not done yet, or null when all are. */
  readonly current: GuideStepId | null;
}

/** Whether a scenario operation is still waiting for its flow. */
function waiting(result: ScenarioResult | undefined, operation: string): boolean {
  return (
    result?.status === "incomplete" && result.operations.some((o) => o.operation === operation)
  );
}

/**
 * Where a new candidate is in getting a scenario evaluated, worked out from
 * the design itself: a service, a route to it, a flow, its first step, every
 * branch answered, and a score.
 */
export function guideFor(
  attempt: Attempt,
  scenario: Scenario | undefined,
  operations: readonly Operation[],
  result: ScenarioResult | undefined,
  catalog: CatalogIndex,
): Guide {
  const focus = (scenario?.focusOperations ?? [])
    .map((id) => operations.find((o) => o.id === id))
    .filter((o): o is Operation => o !== undefined);
  const operation = focus.find((o) => waiting(result, o.id)) ?? focus[0];
  const consumes = operation?.trigger.type === "event";
  const handlers = attempt.architecture.components
    .filter((c) =>
      canHandle(catalog.capabilities(c.kind, c.flavor), operation?.trigger.type ?? "request"),
    )
    .map((c) => c.id);
  const flow = attempt.flows.find((f) => f.operation === operation?.id);
  const reachable =
    operation !== undefined &&
    (flow ? [flow.handler] : handlers).some(
      (id) => findOperationRoute(operation, attempt, catalog, id) !== null,
    );
  const label = operation ? `"${operation.label}"` : "the operation";
  const steps: GuideStep[] = [
    {
      id: "service",
      title: consumes
        ? "Add a service to consume the messages"
        : "Add a service to handle requests",
      done: handlers.length > 0,
    },
    {
      id: "connect",
      title: consumes ? "Connect the queue to the service" : "Connect the client to the service",
      done: reachable,
    },
    { id: "flow", title: `Start the flow for ${label}`, done: flow !== undefined },
    {
      id: "first-step",
      title: "Add its first step",
      done: flow !== undefined && flow.root !== null,
    },
    {
      id: "branches",
      title: "End every branch with a response",
      done: flow !== undefined && flow.root !== null && openSlots(flow, attempt).length === 0,
    },
    { id: "score", title: "Read your score and findings", done: result?.status === "evaluated" },
  ];
  return { operation, steps, current: steps.find((s) => !s.done)?.id ?? null };
}
