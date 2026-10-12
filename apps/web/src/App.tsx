import { Background, Controls, ReactFlow } from "@xyflow/react";

export function App() {
  return (
    <div className="flex h-full flex-col bg-zinc-50 text-zinc-900">
      <header className="flex h-12 items-center border-b border-zinc-200 px-4">
        <h1 className="text-sm font-semibold tracking-tight">ArchDrill</h1>
      </header>
      <main className="min-h-0 flex-1" aria-label="Design canvas">
        <ReactFlow nodes={[]} edges={[]} fitView>
          <Background />
          <Controls />
        </ReactFlow>
      </main>
    </div>
  );
}
