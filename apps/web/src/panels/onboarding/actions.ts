import type { Golden } from "@archdrill/content";
import type { Attempt } from "@archdrill/model";
import { activePack } from "../../state/content";
import type { Guide, GuideStepId } from "../../state/guide";
import { useOnboarding } from "../../state/onboarding";
import { useAttemptStore } from "../../state/store";
import { useToasts } from "../../state/toasts";
import { useUi } from "../../state/ui-store";

/** The first client in the design: where requests come from. */
function clientId(attempt: Attempt): string | undefined {
  return attempt.architecture.components.find((c) => c.kind === "client")?.id;
}

/** Opens the panel a guide step happens in and points at the control to use. */
export function showMe(step: GuideStepId, guide: Guide): void {
  const ui = useUi.getState();
  const spotlight = useOnboarding.getState().showSpotlight;
  const attempt = useAttemptStore.getState().attempt;
  const openFlow = () => {
    ui.setRightTab("flow");
    if (guide.operation) ui.setOperation(guide.operation.id);
  };
  switch (step) {
    case "service":
      ui.openLeftTab("palette");
      spotlight({
        selector: '[data-tour="palette-service"]',
        text: "Click Service to add it, or drag it onto the canvas. It will handle the requests.",
      });
      return;
    case "connect": {
      const client = clientId(attempt);
      spotlight({
        selector: client
          ? `.react-flow__node[data-id="${client}"] .react-flow__handle.source`
          : ".react-flow__pane",
        text: "Drag from this dot to the service to connect them. A load balancer in between works too.",
      });
      return;
    }
    case "flow":
      openFlow();
      spotlight({
        selector: '[data-tour="start-flow"]',
        text: "Choose the service that handles this operation, then start its flow.",
      });
      return;
    case "first-step":
    case "branches":
      openFlow();
      spotlight({
        selector: '[data-tour="open-slot"]',
        text:
          step === "first-step"
            ? "Choose what the service does first: a call, a decision or a response."
            : "Choose what happens next here, or end the request with a response.",
      });
      return;
    case "score":
      ui.setResultsTab("findings");
      spotlight({
        selector: '[data-tour="score"]',
        text: "Your score for this scenario. The findings next to it say what to improve, and why.",
      });
      return;
  }
}

/** Replaces the design with a reference design; undo brings the previous one back. */
export function openExample(example: Golden): void {
  useAttemptStore.getState().replace(example.attempt, { undoable: true });
  useUi.getState().select(null);
  useUi.getState().armSlot(null);
  useToasts
    .getState()
    .notify(`Opened the example "${example.title}". Undo (Ctrl/Cmd+Z) brings your design back.`);
}

/** Scenarios a reference design is meant to pass, as "S1, S2, S3". */
export function exampleCovers(example: Golden): string {
  return activePack.scenarios
    .filter((s) => s.id in example.expect && !example.notPassing.includes(s.id))
    .map((s) => `S${s.order}`)
    .join(", ");
}
