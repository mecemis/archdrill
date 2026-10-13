import { ReactFlowProvider } from "@xyflow/react";
import { DesignCanvas } from "./canvas/DesignCanvas";
import { Header } from "./panels/Header";
import { ResultsDock } from "./panels/results/ResultsDock";
import { LeftPanel, RightPanel } from "./panels/SidePanels";
import { useRegressionWatch } from "./state/use-regression-watch";
import { useShortcuts } from "./state/use-shortcuts";
import { Toasts } from "./ui/Toasts";

export function App() {
  useShortcuts();
  useRegressionWatch();
  return (
    <ReactFlowProvider>
      {/* One explicit column, so a crowded header scrolls instead of widening the page. */}
      <div className="grid h-full grid-cols-1 grid-rows-[auto_minmax(0,1fr)_17rem] bg-zinc-50 text-zinc-900">
        <Header />
        <div className="grid min-h-0 grid-cols-[18rem_minmax(0,1fr)_22rem]">
          <LeftPanel />
          <main className="min-h-0" aria-label="Design canvas">
            <DesignCanvas />
          </main>
          <RightPanel />
        </div>
        <ResultsDock />
        <Toasts />
      </div>
    </ReactFlowProvider>
  );
}
