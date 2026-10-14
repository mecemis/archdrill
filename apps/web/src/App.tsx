import { ReactFlowProvider } from "@xyflow/react";
import { DesignCanvas } from "./canvas/DesignCanvas";
import { Header } from "./panels/Header";
import { ResultsDock } from "./panels/results/ResultsDock";
import { LeftPanel, LeftRail, RightPanel } from "./panels/SidePanels";
import { type DockSize, useUi } from "./state/ui-store";
import { useRegressionWatch } from "./state/use-regression-watch";
import { useShortcuts } from "./state/use-shortcuts";
import { Toasts } from "./ui/Toasts";

/** Grid rows for each results drawer size: header, workspace, drawer. */
const ROWS: Readonly<Record<DockSize, string>> = {
  min: "grid-rows-[auto_minmax(0,1fr)_auto]",
  normal: "grid-rows-[auto_minmax(0,1fr)_minmax(0,34vh)]",
  max: "grid-rows-[auto_minmax(0,1fr)_minmax(0,58vh)]",
};

export function App() {
  useShortcuts();
  useRegressionWatch();
  const dock = useUi((s) => s.dock);
  return (
    <ReactFlowProvider>
      {/* One explicit column, so a crowded header scrolls instead of widening the page. */}
      <div className={`grid h-full grid-cols-1 bg-app text-fg ${ROWS[dock]}`}>
        <Header />
        <div className="flex min-h-0">
          <LeftRail />
          <LeftPanel />
          <main className="min-h-0 min-w-0 flex-1" aria-label="Design canvas">
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
