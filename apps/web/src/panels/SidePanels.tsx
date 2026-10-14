import {
  BookOpenText,
  Calculator,
  type LucideIcon,
  PanelRightClose,
  PanelRightOpen,
  Scale,
  Shapes,
} from "lucide-react";
import { useEffect } from "react";
import { type LeftTab, useUi } from "../state/ui-store";
import { FOCUS_RING, IconButton, Tabs } from "../ui/primitives";
import { BriefPanel } from "./BriefPanel";
import { DecisionsPanel } from "./DecisionsPanel";
import { EstimatePanel } from "./EstimatePanel";
import { FlowPanel } from "./flow/FlowPanel";
import { Inspector } from "./Inspector";
import { Palette } from "./Palette";

const LEFT_TABS: readonly {
  readonly id: LeftTab;
  readonly label: string;
  readonly title: string;
  readonly icon: LucideIcon;
}[] = [
  { id: "brief", label: "Brief", title: "The scenario and the problem", icon: BookOpenText },
  { id: "estimate", label: "Estimate", title: "Back-of-envelope estimates", icon: Calculator },
  { id: "palette", label: "Components", title: "Components to add", icon: Shapes },
  { id: "decisions", label: "Decisions", title: "Design decisions", icon: Scale },
];

/** The icon rail on the far left; choosing the open panel collapses it. */
export function LeftRail() {
  const tab = useUi((s) => s.leftTab);
  const toggle = useUi((s) => s.toggleLeftTab);
  return (
    <div
      role="tablist"
      aria-label="Left panel"
      aria-orientation="vertical"
      className="flex flex-col items-center gap-1 border-r border-line bg-surface py-2"
    >
      {LEFT_TABS.map(({ id, label, title, icon: Icon }) => {
        const selected = tab === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={label}
            title={selected ? `${title} (click to hide)` : title}
            onClick={() => toggle(id)}
            className={`group relative flex w-16 flex-col items-center gap-1 rounded-lg py-1.5 transition-colors ${FOCUS_RING} ${
              selected ? "text-accent-fg" : "text-fg-subtle hover:text-fg"
            }`}
          >
            <span
              className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                selected ? "bg-accent-soft" : "group-hover:bg-muted"
              }`}
            >
              <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            <span className="text-[10px] leading-none font-medium">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

const PANEL_TITLES: Readonly<Record<LeftTab, string>> = {
  brief: "Brief",
  estimate: "Estimate",
  palette: "Components",
  decisions: "Decisions",
};

export function LeftPanel() {
  const tab = useUi((s) => s.leftTab);
  if (tab === null) return null;
  return (
    <aside
      aria-label={PANEL_TITLES[tab]}
      className="flex min-h-0 w-[18rem] shrink-0 flex-col border-r border-line bg-surface"
    >
      <h2 className="flex h-11 shrink-0 items-center border-b border-line px-4 text-sm font-semibold text-fg">
        {PANEL_TITLES[tab]}
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "brief" && <BriefPanel />}
        {tab === "estimate" && <EstimatePanel />}
        {tab === "palette" && <Palette />}
        {tab === "decisions" && <DecisionsPanel />}
      </div>
    </aside>
  );
}

export function RightPanel() {
  const selection = useUi((s) => s.selection);
  const tab = useUi((s) => s.rightTab);
  const open = useUi((s) => s.rightOpen);
  const setTab = useUi((s) => s.setRightTab);
  const setOpen = useUi((s) => s.setRightOpen);
  // Selecting something on the canvas brings up its inspector.
  useEffect(() => {
    if (selection) setTab("inspector");
  }, [selection, setTab]);
  if (!open) {
    return (
      <aside
        aria-label="Flow and inspector"
        className="flex flex-col items-center border-l border-line bg-surface py-2"
      >
        <IconButton
          aria-label="Show the flow and inspector"
          title="Show the flow and inspector"
          onClick={() => setOpen(true)}
        >
          <PanelRightOpen className="h-4 w-4" />
        </IconButton>
      </aside>
    );
  }
  return (
    <aside
      aria-label="Flow and inspector"
      className="flex min-h-0 w-[21rem] shrink-0 flex-col border-l border-line bg-surface"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <Tabs
          label="Right panel"
          value={tab}
          onChange={setTab}
          options={[
            { id: "flow", label: "Flow" },
            { id: "inspector", label: "Inspector" },
          ]}
        />
        <IconButton
          className="ml-auto"
          aria-label="Hide the flow and inspector"
          title="Hide the flow and inspector"
          onClick={() => setOpen(false)}
        >
          <PanelRightClose className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "flow" && <FlowPanel />}
        {tab === "inspector" && <Inspector />}
      </div>
    </aside>
  );
}
