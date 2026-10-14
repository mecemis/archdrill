import type { Step } from "@archdrill/model";
import { useState } from "react";
import { useAttemptStore } from "../../state/store";
import { Button } from "../../ui/primitives";
import { paramsUpdate, StepParams, type TunableValues } from "./StepParams";

/** Edits a call step's parameters; changes apply together, as one undoable change. */
export function StepSettings({
  operation,
  stepId,
  step,
  background,
  onClose,
}: {
  readonly operation: string;
  readonly stepId: string;
  readonly step: Extract<Step, { type: "call" }>;
  readonly background: boolean;
  readonly onClose: () => void;
}) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const [values, setValues] = useState<TunableValues>(step);
  const apply = () => {
    dispatch("updateStep", { operation, stepId, ...paramsUpdate(step.action, values, background) });
    onClose();
  };
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-info-line bg-info-soft p-3"
      data-testid="step-settings"
    >
      <StepParams
        action={step.action}
        values={values}
        onChange={setValues}
        background={background}
      />
      <div className="flex gap-2">
        <Button variant="primary" onClick={apply}>
          Apply
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
