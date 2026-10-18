import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useState } from "react";
import { DesignCanvas } from "./canvas/DesignCanvas";
import { Header } from "./panels/Header";
import { Welcome } from "./panels/onboarding/Welcome";
import { ResultsDock } from "./panels/results/ResultsDock";
import { LeftPanel, LeftRail, RightPanel } from "./panels/SidePanels";
import { dockLimit, useLayout } from "./state/layout";
import { type DockSize, useUi } from "./state/ui-store";
import { useRegressionWatch } from "./state/use-regression-watch";
import { useShortcuts } from "./state/use-shortcuts";
import { useWhatIfDriver } from "./state/what-if";
import { FlowStudio } from "./studio/FlowStudio";
import { Spotlight } from "./ui/Spotlight";
import { Toasts } from "./ui/Toasts";

/** Share of the window the enlarged drawer takes, for timelines. */
const MAX_DOCK_SHARE = 0.58;

function useWindowHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return height;
}

/** The drawer's grid row: its header only, the size it was dragged to, or most of the window. */
function dockRow(dock: DockSize, dragged: number, windowHeight: number): string {
  if (dock === "min") return "auto";
  const height = dock === "max" ? windowHeight * MAX_DOCK_SHARE : dragged;
  return `${Math.round(Math.min(height, dockLimit(windowHeight)))}px`;
}

export function App() {
  useShortcuts();
  useRegressionWatch();
  useWhatIfDriver();
  const dock = useUi((s) => s.dock);
  const dragged = useLayout((s) => s.dock);
  const windowHeight = useWindowHeight();
  // Behind the studio the app takes no focus, clicks or keys.
  const studioOpen = useUi((s) => s.studioOpen);
  return (
    <ReactFlowProvider>
      {/* One explicit column, so a crowded header scrolls instead of widening the page. */}
      <div
        className="grid h-full grid-cols-1 bg-app text-fg"
        style={{ gridTemplateRows: `auto minmax(0,1fr) ${dockRow(dock, dragged, windowHeight)}` }}
      >
        {/* Display contents keeps the grid's rows; inert reaches the whole subtree. */}
        <div className="contents" inert={studioOpen}>
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
        </div>
        <Toasts />
        <Welcome />
        <Spotlight />
        <FlowStudio />
      </div>
    </ReactFlowProvider>
  );
}
