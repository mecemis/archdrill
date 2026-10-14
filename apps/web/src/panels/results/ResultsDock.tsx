import { ChevronDown, ChevronUp, Maximize2, Minimize2 } from "lucide-react";
import { activePack } from "../../state/content";
import { useEvaluation } from "../../state/evaluation";
import { dockLimit, LIMITS, useLayout } from "../../state/layout";
import { useUi } from "../../state/ui-store";
import { IconButton, Tabs } from "../../ui/primitives";
import { ResizeHandle } from "../../ui/ResizeHandle";
import { CompareView } from "./CompareView";
import { Findings } from "./Findings";
import { IssuesList } from "./IssuesList";
import { LoadPanel } from "./LoadPanel";
import { PathExplorer } from "./PathExplorer";
import { ScoreChip, ScoreSummary } from "./ScoreSummary";
import { TimelinePanel } from "./TimelinePanel";

/** The drawer's header, which stays when it is collapsed. */
const COLLAPSED_HEIGHT = 44;
/** Drag the drawer shorter than this and it collapses to its header. */
const COLLAPSE_BELOW = LIMITS.dock.min - 40;

export function ResultsDock() {
  const { analysis, scenarios } = useEvaluation();
  const scenarioId = useUi((s) => s.scenarioId);
  const tab = useUi((s) => s.resultsTab);
  const dock = useUi((s) => s.dock);
  const setTab = useUi((s) => s.setResultsTab);
  const setDock = useUi((s) => s.setDock);
  const scenario = activePack.scenarios.find((s) => s.id === scenarioId);
  const result = scenarios.find((s) => s.scenarioId === scenarioId);
  const checks = result?.status === "evaluated" ? result.checks : [];
  const openCount = checks.filter(
    (c) => c.instance.signal === "baseline" && (c.status === "fail" || c.status === "partial"),
  ).length;
  const hasTimelines = (scenario?.workload?.timelines.length ?? 0) > 0;
  const pathCount = (scenario?.focusOperations ?? []).reduce(
    (sum, op) => sum + (analysis.operations.get(op)?.paths.length ?? 0),
    0,
  );
  const open = dock !== "min";
  const dragged = useLayout((s) => s.dock);
  const height = dock === "min" ? COLLAPSED_HEIGHT : dragged;

  /** Dragging below the collapse point folds the drawer to its header; dragging up opens it. */
  const resize = (next: number) => {
    if (next < COLLAPSE_BELOW) {
      setDock("min");
      return;
    }
    setDock("normal");
    useLayout.getState().setDockHeight(next);
  };

  return (
    <section
      aria-label="Results"
      className="relative flex h-full min-h-0 flex-col border-t border-line bg-surface"
    >
      <ResizeHandle
        axis="y"
        grow={-1}
        value={height}
        min={COLLAPSED_HEIGHT}
        max={dockLimit(window.innerHeight)}
        label="Resize the results"
        onResize={resize}
        onEnd={useLayout.getState().save}
        onReset={() => {
          useLayout.getState().reset("dock");
          setDock("normal");
        }}
        className="-top-1"
      />
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-3">
        <button
          type="button"
          onClick={() => setDock(open ? "min" : "normal")}
          className="flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-muted"
          title={open ? "Collapse the results" : "Show the results"}
          aria-label={open ? "Collapse the results" : "Show the results"}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
          ) : (
            <ChevronUp className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
          )}
          <span className="text-sm font-semibold text-fg">S{scenario?.order} result</span>
          {!open && <ScoreChip result={result} />}
        </button>
        <div className="min-w-0 overflow-x-auto">
          <Tabs
            label="Result views"
            value={tab}
            onChange={setTab}
            options={[
              { id: "findings", label: "Findings", count: openCount },
              { id: "paths", label: "Paths", count: pathCount },
              { id: "load", label: "Load" },
              ...(hasTimelines ? [{ id: "timeline" as const, label: "Timeline" }] : []),
              { id: "issues", label: "Issues", count: analysis.issues.length },
              { id: "compare", label: "Compare" },
            ]}
          />
        </div>
        <IconButton
          className="ml-auto"
          aria-label="Enlarge the results"
          title={dock === "max" ? "Shrink the results" : "Enlarge the results"}
          aria-pressed={dock === "max"}
          onClick={() => setDock(dock === "max" ? "normal" : "max")}
        >
          {dock === "max" ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </IconButton>
      </div>
      {open && (
        <div className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-r border-line">
            <ScoreSummary result={result} />
          </div>
          <div className="min-h-0 overflow-y-auto bg-sunken">
            {tab === "findings" &&
              (result?.status === "evaluated" ? (
                <Findings checks={checks} analysis={analysis} />
              ) : (
                <p className="p-4 text-sm text-fg-subtle">
                  Findings appear once the scenario can be evaluated.
                </p>
              ))}
            {tab === "paths" && (
              <PathExplorer analysis={analysis} operations={scenario?.focusOperations ?? []} />
            )}
            {tab === "load" && <LoadPanel />}
            {tab === "timeline" && hasTimelines && <TimelinePanel />}
            {tab === "issues" && <IssuesList issues={analysis.issues} />}
            {tab === "compare" && <CompareView />}
          </div>
        </div>
      )}
    </section>
  );
}
