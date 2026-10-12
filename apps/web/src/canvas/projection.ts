import type { OperationAnalysis } from "@archdrill/engine";
import {
  type Attempt,
  type CatalogIndex,
  type Flow,
  type Issue,
  liveStepIds,
} from "@archdrill/model";
import type { Edge, Node } from "@xyflow/react";
import type { Highlight, Selection } from "../state/ui-store";

export type Emphasis = "normal" | "highlighted" | "dimmed";

export interface ComponentNodeData extends Record<string, unknown> {
  readonly label: string;
  readonly kind: string;
  readonly flavorLabel: string;
  readonly sizeLabel: string | null;
  readonly replicas: number;
  readonly replicable: boolean;
  readonly entities: readonly string[];
  readonly isHandler: boolean;
  readonly emphasis: Emphasis;
  readonly hasError: boolean;
  /** A step slot is armed and clicking this component would call it. */
  readonly callable: boolean;
}

export interface ConnectionEdgeData extends Record<string, unknown> {
  readonly mode: "sync" | "async";
  /** Numbers of the active flow's steps that use this connection. */
  readonly steps: readonly number[];
  readonly ingress: boolean;
  readonly emphasis: Emphasis;
  readonly hasError: boolean;
}

export interface ProjectionInput {
  readonly attempt: Attempt;
  readonly catalog: CatalogIndex;
  readonly operation: OperationAnalysis | undefined;
  readonly issues: readonly Issue[];
  readonly highlight: Highlight | null;
  readonly selection: Selection;
  readonly slotArmed: boolean;
}

/**
 * Step id → 1-based number in depth-first order from the root. Respond steps
 * are leaves shown inline, so they are not numbered.
 */
export function stepNumbers(flow: Flow | undefined, attempt: Attempt): Map<string, number> {
  if (!flow) return new Map();
  const numbered = liveStepIds(flow, attempt).filter((id) => flow.steps[id]?.type !== "respond");
  return new Map(numbered.map((id, index) => [id, index + 1]));
}

export function projectNodes(input: ProjectionInput): Node<ComponentNodeData>[] {
  const { attempt, catalog, operation, highlight, selection } = input;
  const flow = operation?.flow;
  const erroneous = new Set(
    input.issues.flatMap((i) =>
      i.severity === "error" && i.location.type === "component" ? [i.location.componentId] : [],
    ),
  );
  const callable = new Set(
    input.slotArmed && flow
      ? attempt.architecture.connections
          .filter((c) => c.from === flow.handler && c.mode === "sync")
          .map((c) => c.to)
      : [],
  );
  return attempt.architecture.components.map((component) => {
    const kind = catalog.kind(component.kind);
    const flavor = catalog.flavor(component.kind, component.flavor);
    const size = component.size ? flavor?.sizes[component.size] : undefined;
    return {
      id: component.id,
      type: "component",
      position: attempt.layout[component.id] ?? { x: 0, y: 0 },
      selected: selection?.type === "component" && selection.id === component.id,
      data: {
        label: component.label,
        kind: component.kind,
        flavorLabel: flavor?.label ?? component.flavor,
        sizeLabel: size?.label ?? null,
        replicas: component.replicas,
        replicable: kind?.replicable ?? false,
        entities: component.data.map((d) => d.entity),
        isHandler: flow?.handler === component.id,
        emphasis: emphasisOf(highlight, highlight?.components.has(component.id) ?? false),
        hasError: erroneous.has(component.id),
        callable: callable.has(component.id),
      },
    };
  });
}

export function projectEdges(input: ProjectionInput): Edge<ConnectionEdgeData>[] {
  const { attempt, operation, highlight, selection } = input;
  const flow = operation?.flow;
  const numbers = stepNumbers(flow, attempt);
  const usage = new Map<string, number[]>();
  for (const [stepId, number] of numbers) {
    const step = flow?.steps[stepId];
    if (step?.type !== "call" || !flow) continue;
    const connection = attempt.architecture.connections.find(
      (c) => c.from === flow.handler && c.to === step.target,
    );
    if (connection) usage.set(connection.id, [...(usage.get(connection.id) ?? []), number]);
  }
  const ingress = new Set(operation?.ingress?.connections ?? []);
  const erroneous = new Set(
    input.issues.flatMap((i) =>
      i.severity === "error" && i.location.type === "connection" ? [i.location.connectionId] : [],
    ),
  );
  return attempt.architecture.connections.map((connection) => ({
    id: connection.id,
    type: "connection",
    source: connection.from,
    target: connection.to,
    selected: selection?.type === "connection" && selection.id === connection.id,
    data: {
      mode: connection.mode,
      steps: usage.get(connection.id) ?? [],
      ingress: ingress.has(connection.id),
      emphasis: emphasisOf(highlight, highlight?.connections.has(connection.id) ?? false),
      hasError: erroneous.has(connection.id),
    },
  }));
}

function emphasisOf(highlight: Highlight | null, member: boolean): Emphasis {
  if (!highlight) return "normal";
  return member ? "highlighted" : "dimmed";
}
