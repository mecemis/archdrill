import {
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge,
  type Node,
  type NodeChange,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import { type DragEvent, useCallback, useEffect, useMemo, useState } from "react";
import { catalogIndex } from "../state/content";
import { useEvaluation } from "../state/evaluation";
import { useAttemptStore } from "../state/store";
import { useToasts } from "../state/toasts";
import { useUi } from "../state/ui-store";
import { ComponentNode } from "./ComponentNode";
import { ConnectionEdge, EdgeMarkers } from "./ConnectionEdge";
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
const edgeTypes = { connection: ConnectionEdge };

function CanvasInner() {
  const attempt = useAttemptStore((s) => s.attempt);
  const dispatch = useAttemptStore((s) => s.dispatch);
  const { analysis } = useEvaluation();
  const operationId = useUi((s) => s.operation);
  const selection = useUi((s) => s.selection);
  const slotArmed = useUi((s) => s.slot !== null);
  const hover = useUi((s) => s.hover);
  const pinned = useUi((s) => s.pinned);
  const { screenToFlowPosition } = useReactFlow();

  const operation = analysis.operations.get(operationId);
  const highlight = hover ?? pinned?.highlight ?? null;
  const input = useMemo(
    () => ({
      attempt,
      catalog: catalogIndex,
      operation,
      issues: analysis.issues,
      highlight,
      selection,
      slotArmed,
    }),
    [attempt, operation, analysis.issues, highlight, selection, slotArmed],
  );
  const projectedNodes = useMemo(() => projectNodes(input), [input]);
  const edges = useMemo(() => projectEdges(input), [input]);

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
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
    >
      <EdgeMarkers />
      <Background gap={20} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/** Must be rendered inside a ReactFlowProvider (the app shell provides one). */
export function DesignCanvas() {
  return <CanvasInner />;
}
