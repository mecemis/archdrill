import { type Attempt, canHandle, findOperationRoute, type Operation } from "@archdrill/model";
import { AlertTriangle } from "lucide-react";
import { useMemo, useState } from "react";
import { activePack, catalogIndex } from "../../state/content";
import { useAttemptStore } from "../../state/store";
import { eventLabel, triggerSummary } from "../../state/triggers";
import { useUi } from "../../state/ui-store";
import { Button, Field, SectionTitle, Select } from "../../ui/primitives";
import { StepTree } from "./StepTree";
import { componentLabel } from "./step-label";

export function FlowPanel() {
  const attempt = useAttemptStore((s) => s.attempt);
  const dispatch = useAttemptStore((s) => s.dispatch);
  const operationId = useUi((s) => s.operation);
  const scenarioId = useUi((s) => s.scenarioId);
  const setOperation = useUi((s) => s.setOperation);
  const scenario = activePack.scenarios.find((s) => s.id === scenarioId);
  const operation = activePack.problem.operations.find((o) => o.id === operationId);
  const flow = attempt.flows.find((f) => f.operation === operationId);
  const services = attempt.architecture.components.filter((c) =>
    canHandle(catalogIndex.capabilities(c.kind, c.flavor), operation?.trigger.type === "event"),
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
          {activePack.problem.operations.map((op) => (
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
            <SectionTitle>Steps</SectionTitle>
            <StepTree flow={flow} />
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
        onClick={() => dispatch("createFlow", { operation: operation.id, handler: selected })}
      >
        Start the flow
      </Button>
    </div>
  );
}
