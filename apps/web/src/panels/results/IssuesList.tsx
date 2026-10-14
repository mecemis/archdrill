import type { Issue } from "@archdrill/model";
import { CircleAlert, Info } from "lucide-react";
import { EMPTY_HIGHLIGHT, useUi } from "../../state/ui-store";

/** Validation issues; clicking one selects or highlights what it is about. */
export function IssuesList({ issues }: { readonly issues: readonly Issue[] }) {
  if (issues.length === 0) {
    return <p className="p-3 text-sm text-fg-subtle">The design has no validation issues.</p>;
  }
  const sorted = [...issues].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1,
  );
  return (
    <ul className="flex flex-col gap-1 p-3">
      {sorted.map((issue) => {
        const Icon = issue.severity === "error" ? CircleAlert : Info;
        return (
          <li key={`${issue.code}-${JSON.stringify(issue.location)}`}>
            <button
              type="button"
              onClick={() => locate(issue)}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sunken"
            >
              <Icon
                className={`mt-0.5 h-4 w-4 shrink-0 ${issue.severity === "error" ? "text-bad-fg" : "text-warn-fg"}`}
                aria-label={issue.severity}
              />
              <span className="text-fg">{issue.message}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function locate(issue: Issue): void {
  const ui = useUi.getState();
  const { location } = issue;
  if (location.type === "component") ui.select({ type: "component", id: location.componentId });
  if (location.type === "connection") ui.select({ type: "connection", id: location.connectionId });
  if (location.type === "flow") ui.setOperation(location.operation);
  if (location.type === "step") {
    ui.setOperation(location.operation);
    ui.togglePin(`issue-${location.stepId}`, {
      ...EMPTY_HIGHLIGHT,
      steps: new Set([location.stepId]),
    });
  }
}
