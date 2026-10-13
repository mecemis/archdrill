import { activePack } from "../../state/content";
import { useEvaluation } from "../../state/evaluation";
import { useUi } from "../../state/ui-store";
import { Tabs } from "../../ui/primitives";
import { CompareView } from "./CompareView";
import { Findings } from "./Findings";
import { IssuesList } from "./IssuesList";
import { LoadPanel } from "./LoadPanel";
import { PathExplorer } from "./PathExplorer";
import { ScoreSummary } from "./ScoreSummary";
import { TimelinePanel } from "./TimelinePanel";

export function ResultsDock() {
  const { analysis, scenarios } = useEvaluation();
  const scenarioId = useUi((s) => s.scenarioId);
  const tab = useUi((s) => s.resultsTab);
  const setTab = useUi((s) => s.setResultsTab);
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

  return (
    <section
      aria-label="Results"
      className="grid h-full min-h-0 grid-cols-[18rem_1fr] border-t border-zinc-200 bg-zinc-50"
    >
      <div className="min-h-0 overflow-y-auto border-r border-zinc-200 bg-white">
        <ScoreSummary result={result} />
      </div>
      <div className="flex min-h-0 flex-col">
        <div className="border-b border-zinc-200 bg-white px-3 py-2">
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
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "findings" &&
            (result?.status === "evaluated" ? (
              <Findings checks={checks} analysis={analysis} />
            ) : (
              <p className="p-3 text-sm text-zinc-500">
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
    </section>
  );
}
