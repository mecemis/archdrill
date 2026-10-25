import {
  type Attempt,
  canHandle,
  type Flow,
  findOperationRoute,
  type Operation,
} from "@archdrill/model";
import { AlertTriangle, CircleCheck, Info, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { activePack, catalogIndex } from "../../state/content";
import { useAttemptStore } from "../../state/store";
import { eventLabel, operationsFocusFirst, triggerSummary } from "../../state/triggers";
import { useUi } from "../../state/ui-store";
import { Button, Field, FOCUS_RING, SectionTitle, Select } from "../../ui/primitives";
import { openSlots } from "./add-step";
import { FlowSequence } from "./FlowSequence";
import { componentLabel } from "./step-label";

export function FlowPanel() {
  const attempt = useAttemptStore((s) => s.attempt);
  const dispatch = useAttemptStore((s) => s.dispatch);
  const operationId = useUi((s) => s.operation);
  const scenarioId = useUi((s) => s.scenarioId);
  const setOperation = useUi((s) => s.setOperation);
  const studioOpen = useUi((s) => s.studioOpen);
  const scenario = activePack.scenarios.find((s) => s.id === scenarioId);
  const operation = activePack.problem.operations.find((o) => o.id === operationId);
  const flow = attempt.flows.find((f) => f.operation === operationId);
  const services = attempt.architecture.components.filter((c) =>
    canHandle(catalogIndex.capabilities(c.kind, c.flavor), operation?.trigger.type ?? "request"),
  );
  // Derived here rather than read from the analysis, which is empty while the design has errors.
  const route = useMemo(
    () =>
      flow && operation ? findOperationRoute(operation, attempt, catalogIndex, flow.handler) : null,
    [attempt, flow, operation],
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <Field label="Operation">
        <Select value={operationId} onChange={(e) => setOperation(e.target.value)}>
          {operationsFocusFirst(scenario?.focusOperations ?? []).map((op) => (
            <option key={op.id} value={op.id}>
              {triggerSummary(op)} · {op.label}
              {scenario?.focusOperations.includes(op.id) ? " (in focus)" : ""}
            </option>
          ))}
        </Select>
      </Field>
      {operation?.trigger.type === "event" && (
        <p className="text-xs text-fg-muted">
          Optional: a consumer of {eventLabel(operation.trigger.event)}. Leave it out if your design
          does this work another way.
        </p>
      )}
      {operation && !flow && (
        <CreateFlow operation={operation} services={services.map((s) => s.id)} />
      )}
      {flow && (
        <>
          <Field label="Handled by">
            <Select
              value={flow.handler}
              onChange={(e) =>
                dispatch("setFlowHandler", { operation: flow.operation, handler: e.target.value })
              }
            >
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          {operation && (
            <RouteNote operation={operation} route={route?.components ?? null} attempt={attempt} />
          )}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <SectionTitle>Steps</SectionTitle>
              {!studioOpen && (
                <button
                  type="button"
                  onClick={() => useUi.getState().setStudioOpen(true)}
                  className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-accent-fg hover:bg-accent-soft ${FOCUS_RING}`}
                >
                  <Workflow className="h-3.5 w-3.5" aria-hidden="true" /> Open in the studio
                </button>
              )}
            </div>
            {flow.root === null && <FlowExplainer />}
            <BranchProgress flow={flow} attempt={attempt} />
            <FlowSequence flow={flow} />
          </section>
          <Button
            variant="ghost"
            className="self-start text-xs text-bad-fg"
            onClick={() => dispatch("removeFlow", { operation: flow.operation })}
          >
            Delete this flow
          </Button>
        </>
      )}
    </div>
  );
}

function RouteNote({
  operation,
  route,
  attempt,
}: {
  readonly operation: Operation;
  readonly route: readonly string[] | null;
  readonly attempt: Attempt;
}) {
  const trigger = operation.trigger;
  if (route) {
    const text =
      trigger.type === "event"
        ? `Takes ${eventLabel(trigger.event)} messages from ${componentLabel(attempt, route[0] ?? "")}.`
        : trigger.type === "schedule"
          ? `Runs in the background: ${trigger.description}`
          : `Ingress: ${route.map((id) => componentLabel(attempt, id)).join(" → ")}`;
    return <p className="text-xs text-fg-muted">{text}</p>;
  }
  const handler = attempt.flows.find((f) => f.operation === operation.id)?.handler ?? "";
  return (
    <p className="flex gap-1.5 rounded-md bg-bad-soft px-2.5 py-2 text-xs text-bad-fg">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      {trigger.type === "event"
        ? `${componentLabel(attempt, handler)} receives no ${eventLabel(trigger.event)} messages. Publish the event to a queue in another flow, and connect this service to that queue.`
        : `No client can reach ${componentLabel(attempt, handler)}. Connect a client to it, directly or through a load balancer.`}
    </p>
  );
}

/** What a flow is, for someone about to build their first one. */
function FlowExplainer() {
  return (
    <p className="flex gap-2 rounded-lg border border-info-line bg-info-soft px-3 py-2 text-xs text-info-fg">
      <Info className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        A flow is what the service does for this request, step by step from top to bottom. Pick what
        it does first from the list below. Outcomes that end the request early (not found, an
        error…) get the usual response, which you can change under each step.
      </span>
    </p>
  );
}

/** How many branches still lead nowhere. */
function BranchProgress({ flow, attempt }: { readonly flow: Flow; readonly attempt: Attempt }) {
  if (flow.root === null) return null;
  const open = openSlots(flow, attempt).length;
  if (open === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-ok-fg">
        <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
        Every branch ends with a response.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
      <span>
        {open} open branch{open === 1 ? "" : "es"} left
      </span>
    </div>
  );
}

const CREATE_PROMPTS: Readonly<Record<Operation["trigger"]["type"], string>> = {
  request: "Which service handles this request?",
  event: "Which service consumes these messages?",
  schedule: "Which service runs this job?",
};

function CreateFlow({
  operation,
  services,
}: {
  readonly operation: Operation;
  readonly services: readonly string[];
}) {
  const attempt = useAttemptStore((s) => s.attempt);
  const dispatch = useAttemptStore((s) => s.dispatch);
  const [handler, setHandler] = useState(services[0] ?? "");
  const selected = services.includes(handler) ? handler : (services[0] ?? "");
  if (services.length === 0) {
    return (
      <p className="rounded-md bg-warn-soft px-2.5 py-2 text-sm text-warn-fg">
        Add a Service from the palette first. It will handle this operation.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-fg-muted">{CREATE_PROMPTS[operation.trigger.type]}</p>
      <Select value={selected} onChange={(e) => setHandler(e.target.value)} aria-label="Handler">
        {services.map((id) => (
          <option key={id} value={id}>
            {componentLabel(attempt, id)}
          </option>
        ))}
      </Select>
      <Button
        variant="primary"
        className="self-start"
        data-tour="start-flow"
        onClick={() => dispatch("createFlow", { operation: operation.id, handler: selected })}
      >
        Start the flow
      </Button>
    </div>
  );
}
