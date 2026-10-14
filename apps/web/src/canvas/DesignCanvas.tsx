import {
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge,
  type Node,
  type NodeChange,
  Panel,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import { Activity } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GuideCard } from "../panels/onboarding/GuideCard";
import { catalogIndex } from "../state/content";
import { useEvaluation } from "../state/evaluation";
import { useLayout } from "../state/layout";
import { useOnboarding } from "../state/onboarding";
import { useAttemptStore } from "../state/store";
import { useTheme } from "../state/theme";
import { useCanvasLoad } from "../state/timeline-view";
import { useToasts } from "../state/toasts";
import { useUi } from "../state/ui-store";
import { IconButton } from "../ui/primitives";
import { ComponentNode } from "./ComponentNode";
import { ConnectionEdge, EdgeMarkers } from "./ConnectionEdge";
import { findingsByComponent } from "./node-findings";
import { addComponentFromPalette, PALETTE_MIME, parsePaletteData } from "./palette-drop";
import { type ComponentNodeData, projectEdges, projectNodes } from "./projection";

/**
 * Deletes what the user removed on the canvas as one undoable step. Edges that
 * belong to removed nodes go away with their nodes.
 */
function removeFromCanvas(nodes: readonly Node[], edges: readonly Edge[]): void {
  const store = useAttemptStore.getState();
  const nodeIds = new Set(nodes.map((n) => n.id));
  const flowsBefore = store.attempt.flows.length;
  const removed = store.dispatchAll([
    ...edges
      .filter((e) => !nodeIds.has(e.source) && !nodeIds.has(e.target))
      .map((e) => ({ name: "removeConnection" as const, args: { id: e.id } })),
    ...nodes.map((n) => ({ name: "removeComponent" as const, args: { id: n.id } })),
  ]);
  if (!removed) return;
  useUi.getState().select(null);
  const lostFlows = flowsBefore - useAttemptStore.getState().attempt.flows.length;
  if (lostFlows > 0) {
    const plural = lostFlows === 1 ? "" : "s";
    useToasts
      .getState()
      .notify(
        `Removed ${lostFlows} flow${plural} handled by the deleted service. Undo with Ctrl/Cmd+Z.`,
      );
  }
}

const nodeTypes = { component: ComponentNode };
const FIT_OPTIONS = { padding: 0.15, maxZoom: 1 } as const;
/** How long the view takes to fit a design that was loaded or reset. */
const FIT_DURATION_MS = 250;
/** Time for React Flow to receive and measure new nodes before fitting them. */
const FIT_DELAY_MS = 120;

/**
 * Fits the view when several components appear or disappear at once (a design
 * imported, reset or restored); adding or removing one keeps the view still.
 */
function useFitOnReplace(nodeIds: string) {
  const { fitView } = useReactFlow();
  const previous = useRef(nodeIds);
  useEffect(() => {
    const before = new Set(previous.current.split(" ").filter(Boolean));
    const after = new Set(nodeIds.split(" ").filter(Boolean));
    previous.current = nodeIds;
    const changed =
      [...after].filter((id) => !before.has(id)).length +
      [...before].filter((id) => !after.has(id)).length;
    if (changed <= 1) return;
    const timer = setTimeout(
      () => void fitView({ ...FIT_OPTIONS, duration: FIT_DURATION_MS }),
      FIT_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [nodeIds, fitView]);
}
const edgeTypes = { connection: ConnectionEdge };

function CanvasInner() {
  const attempt = useAttemptStore((s) => s.attempt);
  const dispatch = useAttemptStore((s) => s.dispatch);
  const { analysis, scenarios } = useEvaluation();
  const scenarioId = useUi((s) => s.scenarioId);
  const animateTraffic = useLayout((s) => s.animateTraffic);
  const guideOpen = useOnboarding((s) => s.guideOpen);
  const operationId = useUi((s) => s.operation);
  const selection = useUi((s) => s.selection);
  const slotArmed = useUi((s) => s.slot !== null);
  const hover = useUi((s) => s.hover);
  const pinned = useUi((s) => s.pinned);
  const { screenToFlowPosition } = useReactFlow();
  const { load: metrics, moment } = useCanvasLoad();
  const theme = useTheme((s) => s.theme);

  const operation = analysis.operations.get(operationId);
  const highlight = hover ?? pinned?.highlight ?? null;
  const result = scenarios.find((s) => s.scenarioId === scenarioId);
  const findings = useMemo(
    () =>
      result?.status === "evaluated"
        ? findingsByComponent(result.checks, attempt, analysis)
        : undefined,
    [result, attempt, analysis],
  );
  const input = useMemo(
    () => ({
      attempt,
      catalog: catalogIndex,
      operation,
      issues: analysis.issues,
      highlight,
      selection,
      slotArmed,
      metrics,
      findings,
    }),
    [attempt, operation, analysis.issues, highlight, selection, slotArmed, metrics, findings],
  );
  const projectedNodes = useMemo(() => projectNodes(input), [input]);
  const edges = useMemo(() => projectEdges(input), [input]);
  useFitOnReplace(projectedNodes.map((n) => n.id).join(" "));

  // React Flow needs live positions while dragging; the attempt only changes on drop.
  const [nodes, setNodes] = useState<Node<ComponentNodeData>[]>(projectedNodes);
  useEffect(
    () =>
      setNodes((current) =>
        projectedNodes.map((node) => {
          const live = current.find((n) => n.id === node.id);
          return live?.dragging ? { ...node, position: live.position, dragging: true } : node;
        }),
      ),
    [projectedNodes],
  );

  const onNodesChange = useCallback((changes: NodeChange<Node<ComponentNodeData>>[]) => {
    const local = changes.filter((c) => c.type === "position" || c.type === "dimensions");
    if (local.length > 0) setNodes((current) => applyNodeChanges(local, current));
  }, []);

  const onNodeDragStop = useCallback((_event: unknown, _node: Node, dragged: Node[]) => {
    useAttemptStore.getState().dispatchAll(
      dragged.map((node) => ({
        name: "moveComponent" as const,
        args: { id: node.id, position: node.position },
      })),
    );
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      const id = dispatch("addConnection", { from: connection.source, to: connection.target });
      if (id) useUi.getState().select({ type: "connection", id });
    },
    [dispatch],
  );

  const onNodeClick = useCallback((_event: unknown, node: Node<ComponentNodeData>) => {
    const ui = useUi.getState();
    if (ui.slot && node.data.callable) ui.setCanvasTarget(node.id);
    else ui.select({ type: "component", id: node.id });
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const item = parsePaletteData(event.dataTransfer.getData(PALETTE_MIME));
      if (!item) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const id = addComponentFromPalette(item, position, dispatch);
      if (id) useUi.getState().select({ type: "component", id });
    },
    [dispatch, screenToFlowPosition],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onNodeClick={onNodeClick}
      onEdgeClick={(_e, edge: Edge) => useUi.getState().select({ type: "connection", id: edge.id })}
      onPaneClick={() => {
        useUi.getState().select(null);
        useUi.getState().clearPin();
      }}
      onDelete={({ nodes: deletedNodes, edges: deletedEdges }) =>
        removeFromCanvas(deletedNodes, deletedEdges)
      }
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={onDrop}
      colorMode={theme}
      fitView
      fitViewOptions={FIT_OPTIONS}
    >
      <EdgeMarkers />
      <Background gap={22} size={1.4} />
      <Controls showInteractive={false} position="bottom-left" />
      {metrics && (
        <Panel position="top-right">
          <IconButton
            active={animateTraffic}
            aria-pressed={animateTraffic}
            aria-label="Animate traffic"
            title={
              animateTraffic ? "Stop the moving traffic" : "Show traffic moving along connections"
            }
            onClick={() => useLayout.getState().setAnimateTraffic(!animateTraffic)}
            className={`border border-line shadow-card ${animateTraffic ? "" : "bg-elevated"}`}
          >
            <Activity className="h-4 w-4" />
          </IconButton>
        </Panel>
      )}
      {guideOpen && (
        <Panel position="bottom-right" className="!mb-6">
          <GuideCard />
        </Panel>
      )}
      {attempt.architecture.components.length <= 1 && !moment && !guideOpen && (
        <Panel position="top-center">
          <p className="rounded-xl border border-line bg-elevated px-4 py-2.5 text-sm text-fg-muted shadow-pop">
            Start from <span className="font-semibold text-fg">Components</span> on the left: drag a
            service onto the canvas, then connect it from the client's handle.
          </p>
        </Panel>
      )}
      {moment && (
        <Panel position="top-center">
          <p
            className="flex items-center gap-2 whitespace-nowrap rounded-xl border border-info-line bg-elevated px-3 py-1.5 text-sm text-info-fg shadow-pop"
            data-testid="canvas-moment"
          >
            Showing {moment.label} at {moment.at} s
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-xs font-medium underline hover:bg-info-soft"
              onClick={() => useUi.getState().setTimelineCursor(null)}
            >
              Back to the environment
            </button>
          </p>
        </Panel>
      )}
    </ReactFlow>
  );
}

/** Must be rendered inside a ReactFlowProvider (the app shell provides one). */
export function DesignCanvas() {
  return <CanvasInner />;
}
