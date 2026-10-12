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
import { useUi } from "../state/ui-store";
import { ComponentNode } from "./ComponentNode";
import { ConnectionEdge, EdgeMarkers } from "./ConnectionEdge";
import { addComponentFromPalette, PALETTE_MIME, parsePaletteData } from "./palette-drop";
import { type ComponentNodeData, projectEdges, projectNodes } from "./projection";

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
  useEffect(() => setNodes(projectedNodes), [projectedNodes]);

  const onNodesChange = useCallback((changes: NodeChange<Node<ComponentNodeData>>[]) => {
    const local = changes.filter((c) => c.type === "position" || c.type === "dimensions");
    if (local.length > 0) setNodes((current) => applyNodeChanges(local, current));
  }, []);

  const onNodeDragStop = useCallback(
    (_event: unknown, _node: Node, dragged: Node[]) => {
      for (const node of dragged)
        dispatch("moveComponent", { id: node.id, position: node.position });
    },
    [dispatch],
  );

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
      onNodesDelete={(deleted) => {
        for (const node of deleted) dispatch("removeComponent", { id: node.id });
      }}
      onEdgesDelete={(deleted) => {
        for (const edge of deleted) dispatch("removeConnection", { id: edge.id });
      }}
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
