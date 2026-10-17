import type { OperationAnalysis } from "@archdrill/engine";
import {
  type Attempt,
  type CatalogIndex,
  callableFrom,
  type Flow,
  findOperationRoute,
  type Issue,
  liveStepIds,
  type Operation,
  placedInZones,
  runsInRegion,
} from "@archdrill/model";
import type { Edge, Node } from "@xyflow/react";
import type { Highlight, Selection } from "../state/ui-store";
import type { NodeFindings } from "./node-findings";

export type Emphasis = "normal" | "highlighted" | "dimmed";

/**
 * How a component is doing under the simulated load: overloaded or failing
 * (critical), close to its capacity (warn), or fine.
 */
export type Health = "ok" | "warn" | "critical";

/** Utilisation above which a component is shown as close to its capacity. */
export const WARN_UTILIZATION = 0.85;

export interface ComponentNodeData extends Record<string, unknown> {
  readonly label: string;
  readonly kind: string;
  readonly flavorLabel: string;
  readonly sizeLabel: string | null;
  readonly replicas: number;
  /** Shards for shardable kinds, otherwise null. */
  readonly shards: number | null;
  /** Zones its instances are spread over, for components a design places; otherwise null. */
  readonly zones: number | null;
  /** It keeps a standby copy in a second region. */
  readonly standby: boolean;
  readonly replicable: boolean;
  readonly entities: readonly string[];
  readonly isHandler: boolean;
  readonly emphasis: Emphasis;
  readonly hasError: boolean;
  /** A step slot is armed and clicking this component would call it. */
  readonly callable: boolean;
  /** Simulated utilisation in the selected environment, or null without a simulation. */
  readonly utilization: number | null;
  /** Faults the selected environment injects into this component. */
  readonly faults: readonly string[];
  /** Those faults fail or slow its calls; otherwise they only cost it instances. */
  readonly faultDisrupts: boolean;
  /** Autoscaling ceiling, or null for a fixed number of replicas. */
  readonly autoscaleMax: number | null;
  /** Instances it runs in the selected environment, or null without a simulation. */
  readonly running: number | null;
  /** Utilisation of its hottest shard when a hot key makes it busier than the rest, else null. */
  readonly hotShard: number | null;
  /** Health under the simulated load, or null without a simulation. */
  readonly health: Health | null;
  /** Open findings that point at it, or null when there are none. */
  readonly findings: NodeFindings | null;
}

export interface ConnectionEdgeData extends Record<string, unknown> {
  /** Nothing waits on it: messages published without waiting, or delivered by a queue. */
  readonly messaging: boolean;
  /** Numbers of the active flow's steps that use this connection. */
  readonly steps: readonly number[];
  readonly ingress: boolean;
  readonly emphasis: Emphasis;
  readonly hasError: boolean;
  /** Simulated requests per second over the connection, or null without a simulation. */
  readonly rate: number | null;
  /** Health of the component the connection leads to, or null without a simulation. */
  readonly targetHealth: Health | null;
}

export interface ProjectionInput {
  readonly attempt: Attempt;
  readonly catalog: CatalogIndex;
  readonly operation: OperationAnalysis | undefined;
  readonly issues: readonly Issue[];
  readonly highlight: Highlight | null;
  readonly selection: Selection;
  readonly slotArmed: boolean;
  /** The problem's operations, to tell which flows consume messages. */
  readonly operations?: readonly Operation[];
  readonly metrics?: CanvasLoad | undefined;
  /** Open findings per component, for badges. */
  readonly findings?: ReadonlyMap<string, NodeFindings> | undefined;
}

/**
 * What the canvas shows about load: an environment's steady state, or one
 * moment of a timeline.
 */
export interface CanvasLoad {
  readonly components: ReadonlyMap<
    string,
    {
      readonly utilization: number;
      readonly hottestShardUtilization: number;
      readonly instances: number;
      readonly faults: readonly string[];
      /** The faults fail or slow its calls; otherwise they only cost it capacity. */
      readonly faultDisrupts: boolean;
    }
  >;
  /** Requests per second over each connection. */
  readonly connections: ReadonlyMap<string, number>;
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

/**
 * Connections nothing waits on: every step over them publishes without
 * waiting (fire-and-forget or through an outbox), or a queue delivers a
 * consumer's messages over them. They are drawn dashed.
 */
export function messagingConnections(
  attempt: Attempt,
  catalog: CatalogIndex,
  operations: readonly Operation[] = [],
): Set<string> {
  const waits = new Set<string>();
  const messages = new Set<string>();
  for (const flow of attempt.flows) {
    for (const id of liveStepIds(flow, attempt)) {
      const step = flow.steps[id];
      if (step?.type !== "call") continue;
      const connection = attempt.architecture.connections.find(
        (c) => c.from === flow.handler && c.to === step.target,
      );
      if (!connection) continue;
      (step.fireAndForget || step.outbox ? messages : waits).add(connection.id);
    }
    const operation = operations.find((o) => o.id === flow.operation);
    if (operation?.trigger.type === "event") {
      const route = findOperationRoute(operation, attempt, catalog, flow.handler);
      for (const id of route?.connections ?? []) messages.add(id);
    }
  }
  return new Set([...messages].filter((id) => !waits.has(id)));
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
    input.slotArmed && flow ? callableFrom(flow.handler, attempt, catalog) : [],
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
        shards: kind?.shardable ? component.shards : null,
        zones: kind && flavor && placedInZones(kind, flavor) ? component.zones : null,
        standby:
          kind !== undefined &&
          flavor !== undefined &&
          runsInRegion(kind, flavor) &&
          component.regions > 1,
        replicable: (kind?.replicable ?? false) && !(flavor?.managedRedundancy ?? false),
        entities: component.data.map((d) => d.entity),
        isHandler: flow?.handler === component.id,
        emphasis: emphasisOf(highlight, highlight?.components.has(component.id) ?? false),
        hasError: erroneous.has(component.id),
        callable: callable.has(component.id),
        utilization: input.metrics?.components.get(component.id)?.utilization ?? null,
        faults: input.metrics?.components.get(component.id)?.faults ?? [],
        faultDisrupts: input.metrics?.components.get(component.id)?.faultDisrupts ?? false,
        autoscaleMax: component.autoscale?.max ?? null,
        running: input.metrics?.components.get(component.id)?.instances ?? null,
        hotShard: hotShardOf(input.metrics?.components.get(component.id)),
        health: healthOf(input.metrics?.components.get(component.id)),
        findings: input.findings?.get(component.id) ?? null,
      },
    };
  });
}

/**
 * Failing, slowed or overloaded is critical. Close to capacity, on any
 * shard, is a warning, and so is a fault that only cost it instances.
 */
export function healthOf(
  metrics:
    | {
        readonly utilization: number;
        readonly hottestShardUtilization: number;
        readonly faults: readonly string[];
        readonly faultDisrupts: boolean;
      }
    | undefined,
): Health | null {
  if (!metrics) return null;
  const busiest = Math.max(metrics.utilization, metrics.hottestShardUtilization);
  if (metrics.faultDisrupts || busiest > 1) return "critical";
  return busiest > WARN_UTILIZATION || metrics.faults.length > 0 ? "warn" : "ok";
}

/** Hot shards worth pointing out: noticeably busier than the tier as a whole. */
const HOT_SHARD_MARGIN = 0.05;

function hotShardOf(
  metrics: { utilization: number; hottestShardUtilization: number } | undefined,
): number | null {
  if (!metrics) return null;
  return metrics.hottestShardUtilization > metrics.utilization + HOT_SHARD_MARGIN
    ? metrics.hottestShardUtilization
    : null;
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
  const messaging = messagingConnections(attempt, input.catalog, input.operations);
  return attempt.architecture.connections.map((connection) => ({
    id: connection.id,
    type: "connection",
    source: connection.from,
    target: connection.to,
    selected: selection?.type === "connection" && selection.id === connection.id,
    data: {
      messaging: messaging.has(connection.id),
      steps: usage.get(connection.id) ?? [],
      ingress: ingress.has(connection.id),
      emphasis: emphasisOf(highlight, highlight?.connections.has(connection.id) ?? false),
      hasError: erroneous.has(connection.id),
      rate: input.metrics ? (input.metrics.connections.get(connection.id) ?? 0) : null,
      targetHealth: healthOf(input.metrics?.components.get(connection.to)),
    },
  }));
}

function emphasisOf(highlight: Highlight | null, member: boolean): Emphasis {
  // A highlight with nothing on the canvas (a decision) leaves the canvas as it is.
  if (!highlight || highlight.components.size + highlight.connections.size === 0) return "normal";
  return member ? "highlighted" : "dimmed";
}
