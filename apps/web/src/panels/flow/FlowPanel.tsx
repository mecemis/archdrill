import { findIngressRoute } from "@archdrill/model";
import { AlertTriangle } from "lucide-react";
import { useMemo, useState } from "react";
import { activePack, catalogIndex } from "../../state/content";
import { useAttemptStore } from "../../state/store";
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
    catalogIndex.capabilities(c.kind, c.flavor).has("stateless-compute"),
  );
  // Derived here rather than read from the analysis, which is empty while the design has errors.
  const ingress = useMemo(
    () => (flow ? findIngressRoute(attempt.architecture, catalogIndex, flow.handler) : null),
    [attempt.architecture, flow],
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <Field label="Operation">
        <Select value={operationId} onChange={(e) => setOperation(e.target.value)}>
          {activePack.problem.operations.map((op) => (
            <option key={op.id} value={op.id}>
              {op.method} {op.path} · {op.label}
              {scenario?.focusOperations.includes(op.id) ? " (in focus)" : ""}
            </option>
          ))}
        </Select>
      </Field>
      {operation && !flow && (
        <CreateFlow operationId={operation.id} services={services.map((s) => s.id)} />
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
          {ingress ? (
            <p className="text-xs text-zinc-600">
              Ingress: {ingress.components.map((id) => componentLabel(attempt, id)).join(" → ")}
            </p>
          ) : (
            <p className="flex gap-1.5 rounded-md bg-rose-50 px-2.5 py-2 text-xs text-rose-800">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              No client can reach {componentLabel(attempt, flow.handler)}. Connect a client to it,
              directly or through a load balancer.
            </p>
          )}
          <section className="flex flex-col gap-2">
            <SectionTitle>Steps</SectionTitle>
            <StepTree flow={flow} />
          </section>
          <Button
            variant="ghost"
            className="self-start text-xs text-rose-700"
            onClick={() => dispatch("removeFlow", { operation: flow.operation })}
          >
            Delete this flow
          </Button>
        </>
      )}
    </div>
  );
}

function CreateFlow({
  operationId,
  services,
}: {
  readonly operationId: string;
  readonly services: readonly string[];
}) {
  const attempt = useAttemptStore((s) => s.attempt);
  const dispatch = useAttemptStore((s) => s.dispatch);
  const [handler, setHandler] = useState(services[0] ?? "");
  const selected = services.includes(handler) ? handler : (services[0] ?? "");
  if (services.length === 0) {
    return (
      <p className="rounded-md bg-amber-50 px-2.5 py-2 text-sm text-amber-950">
        Add a Service from the palette first. It will handle this operation.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-zinc-700">Which service handles this request?</p>
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
        onClick={() => dispatch("createFlow", { operation: operationId, handler: selected })}
      >
        Start the flow
      </Button>
    </div>
  );
}
