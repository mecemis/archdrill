import type { Analysis, Path, PathStep } from "@archdrill/engine";
import { ACTIONS, LOGIC } from "@archdrill/model";
import { highlightFromPath, useScenarioLoad } from "../../state/evaluation";
import { useAttemptStore } from "../../state/store";
import { triggerSummary } from "../../state/triggers";
import { useUi } from "../../state/ui-store";
import { milliseconds, percent } from "../../ui/format";
import { OutcomeChip, StatusBadge } from "../../ui/outcome";
import { componentLabel } from "../flow/step-label";

export function PathExplorer({
  analysis,
  operations,
}: {
  readonly analysis: Analysis;
  readonly operations: readonly string[];
}) {
  return (
    <div className="flex flex-col gap-4 p-3">
      {operations.map((operationId) => {
        const op = analysis.operations.get(operationId);
        if (!op) return null;
        return (
          <section key={operationId} className="flex flex-col gap-1">
            <h4 className="text-xs font-semibold text-fg-muted">
              {triggerSummary(op.operation)} · {op.paths.length} path
              {op.paths.length === 1 ? "" : "s"}
              {op.truncated && " (truncated)"}
            </h4>
            {op.paths.length === 0 && (
              <p className="text-sm text-fg-subtle">No paths yet. Add steps to the flow.</p>
            )}
            <ol className="flex flex-col gap-1">
              {op.paths.map((path) => (
                <PathRow
                  key={path.id}
                  path={path}
                  onHighlight={() => highlightFromPath(op, path.id)}
                />
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function PathRow({
  path,
  onHighlight,
}: {
  readonly path: Path;
  readonly onHighlight: () => ReturnType<typeof highlightFromPath>;
}) {
  const attempt = useAttemptStore((s) => s.attempt);
  const pinned = useUi((s) => s.pinned?.key === path.id);
  const { setHover, togglePin } = useUi.getState();
  const status = path.terminal.kind === "respond" ? path.terminal.status : null;
  const load = useScenarioLoad()
    .metrics?.operations.get(path.operation)
    ?.paths.find((p) => p.pathId === path.id);
  return (
    <li>
      <button
        type="button"
        onMouseEnter={() => setHover(onHighlight())}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(onHighlight())}
        onBlur={() => setHover(null)}
        onClick={() => togglePin(path.id, onHighlight())}
        aria-pressed={pinned}
        className={`flex w-full flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 text-left ${
          pinned ? "border-warn-line bg-warn-soft" : "border-line bg-surface hover:bg-sunken"
        }`}
      >
        <span className="w-7 font-mono text-xs text-fg-subtle">#{path.index}</span>
        {path.steps.map((step) => (
          <span key={step.stepId} className="flex items-center gap-1 text-xs text-fg-muted">
            <span>{describe(step, (id) => componentLabel(attempt, id))}</span>
            <OutcomeChip outcome={step.outcome} />
            <span className="text-fg-subtle" aria-hidden="true">
              →
            </span>
          </span>
        ))}
        <StatusBadge status={status} />
        {load && (
          <span
            className="ml-auto text-xs text-fg-muted tabular-nums"
            title="Share of requests and p99 in the selected environment"
          >
            {percent(load.probability, load.probability < 0.01 ? 2 : 1)} · p99{" "}
            {milliseconds(load.latency.p99)}
          </span>
        )}
      </button>
    </li>
  );
}

function describe(step: PathStep, label: (id: string) => string): string {
  if (step.kind === "logic") return LOGIC[step.logic].label;
  return `${label(step.target)} ${ACTIONS[step.action].label}`;
}
