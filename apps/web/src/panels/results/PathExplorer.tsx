import type { Analysis, Path, PathStep } from "@archdrill/engine";
import { ACTIONS, LOGIC } from "@archdrill/model";
import { highlightFromPath } from "../../state/evaluation";
import { useAttemptStore } from "../../state/store";
import { useUi } from "../../state/ui-store";
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
            <h4 className="text-xs font-semibold text-zinc-600">
              {op.operation.method} {op.operation.path} · {op.paths.length} path
              {op.paths.length === 1 ? "" : "s"}
              {op.truncated && " (truncated)"}
            </h4>
            {op.paths.length === 0 && (
              <p className="text-sm text-zinc-500">No paths yet. Add steps to the flow.</p>
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
          pinned ? "border-amber-400 bg-amber-50" : "border-zinc-200 bg-white hover:bg-zinc-50"
        }`}
      >
        <span className="w-7 font-mono text-xs text-zinc-500">#{path.index}</span>
        {path.steps.map((step) => (
          <span key={step.stepId} className="flex items-center gap-1 text-xs text-zinc-700">
            <span>{describe(step, (id) => componentLabel(attempt, id))}</span>
            <OutcomeChip outcome={step.outcome} />
            <span className="text-zinc-400" aria-hidden="true">
              →
            </span>
          </span>
        ))}
        <StatusBadge status={status} />
      </button>
    </li>
  );
}

function describe(step: PathStep, label: (id: string) => string): string {
  if (step.kind === "logic") return LOGIC[step.logic].label;
  return `${label(step.target)} ${ACTIONS[step.action].label}`;
}
