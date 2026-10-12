import { useEffect, useState } from "react";
import { useUi } from "../state/ui-store";
import { Tabs } from "../ui/primitives";
import { BriefPanel } from "./BriefPanel";
import { DecisionsPanel } from "./DecisionsPanel";
import { FlowPanel } from "./flow/FlowPanel";
import { Inspector } from "./Inspector";
import { Palette } from "./Palette";

type LeftTab = "brief" | "palette";
type RightTab = "flow" | "inspector" | "decisions";

export function LeftPanel() {
  const [tab, setTab] = useState<LeftTab>("brief");
  return (
    <aside
      aria-label="Brief and palette"
      className="flex min-h-0 flex-col border-r border-zinc-200 bg-white"
    >
      <div className="border-b border-zinc-200 px-3 py-2">
        <Tabs
          label="Left panel"
          value={tab}
          onChange={setTab}
          options={[
            { id: "brief", label: "Brief" },
            { id: "palette", label: "Components" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "brief" ? <BriefPanel /> : <Palette />}
      </div>
    </aside>
  );
}

export function RightPanel() {
  const selection = useUi((s) => s.selection);
  const [tab, setTab] = useState<RightTab>("flow");
  // Selecting something on the canvas brings up its inspector.
  useEffect(() => {
    if (selection) setTab("inspector");
  }, [selection]);
  return (
    <aside
      aria-label="Flow, inspector and decisions"
      className="flex min-h-0 flex-col border-l border-zinc-200 bg-white"
    >
      <div className="border-b border-zinc-200 px-3 py-2">
        <Tabs
          label="Right panel"
          value={tab}
          onChange={setTab}
          options={[
            { id: "flow", label: "Flow" },
            { id: "inspector", label: "Inspector" },
            { id: "decisions", label: "Decisions" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "flow" && <FlowPanel />}
        {tab === "inspector" && <Inspector />}
        {tab === "decisions" && <DecisionsPanel />}
      </div>
    </aside>
  );
}
