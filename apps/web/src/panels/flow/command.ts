import type { Step, StepInput } from "@archdrill/model";
import { slotFor } from "./cursor";
import type { EditContext } from "./flow-edits";
import { type Pattern, patternsAt } from "./patterns";
import type { PickerMode } from "./pick";
import { stepSentence } from "./sentences";
import { componentLabel } from "./step-label";
import { callOptions, decisionOptions, responseOptions } from "./step-options";
import { suggestNext } from "./suggestions";

/** What one choice of the command line adds. */
export type Addition =
  | { readonly kind: "step"; readonly step: StepInput }
  | { readonly kind: "pattern"; readonly pattern: Pattern };

/** A step or a pattern the command line offers, as it reads. */
export interface Choice {
  readonly key: string;
  /** The step's sentence, or the pattern's name and what it does. */
  readonly label: string;
  /** Said next to it: "Likely next", "Pattern", the component it calls, "Decide", "Respond". */
  readonly group: string;
  readonly add: Addition;
}

/** Whether a suggested step does what an existing step does. */
function sameStep(input: StepInput, step: Step | undefined): boolean {
  if (!step || input.type !== step.type) return false;
  if (input.type === "call" && step.type === "call") {
    return input.target === step.target && input.action === step.action;
  }
  return input.type === "logic" && step.type === "logic" && input.logic === step.logic;
}

/**
 * Everything that can go at a place, in the order the picker shows it: the
 * likely next steps, the patterns that fit, calls on the components the
 * service is connected to, decisions, responses, then calls that connect it.
 * A step comes once, where it first appears.
 */
export function choicesAt(
  ctx: EditContext,
  mode: PickerMode,
  entity: string,
  facts: ReadonlySet<string>,
): Choice[] {
  const { attempt, flow, background } = ctx;
  const step = (group: string, key: string, input: StepInput): Choice => ({
    key,
    label: stepSentence(input, attempt, background),
    group,
    add: { kind: "step", step: input },
  });
  const suggested = suggestNext({
    attempt,
    flow,
    slot: slotFor(flow.operation, mode, "canvas"),
    problem: ctx.problem,
    operation: ctx.operation,
    catalog: ctx.catalog,
    background,
    defaultEntity: entity,
    facts,
  })
    .filter((s) => mode.kind === "append" || s.step.type !== "respond")
    // Inserting in front of a step, that same step is never the suggestion.
    .filter((s) => mode.kind !== "insert" || !sameStep(s.step, flow.steps[mode.before]))
    .slice(0, 4)
    .map((s) => step("Likely next", s.key, s.step));
  const patterns = patternsAt(ctx, mode, entity).map(
    (pattern): Choice => ({
      key: `pattern:${pattern.key}`,
      label: `${pattern.name}: ${pattern.label}`,
      group: "Pattern",
      add: { kind: "pattern", pattern },
    }),
  );
  const calls = [...callOptions(attempt, flow.handler, entity, ctx.catalog)];
  const callsOn = (connected: boolean) =>
    calls
      .filter(([, t]) => t.connected === connected)
      .flatMap(([target, t]) =>
        t.options.map((o) => step(componentLabel(attempt, target), o.key, o.step)),
      );
  const all = [
    ...suggested,
    ...patterns,
    ...callsOn(true),
    ...decisionOptions(ctx, facts).map((o) => step("Decide", o.key, o.step)),
    ...responseOptions(ctx, mode).map((o) =>
      step(background ? "Finish" : "Respond", o.key, o.step),
    ),
    ...callsOn(false),
  ];
  const seen = new Set<string>();
  return all.filter((choice) => {
    const id = choice.add.kind === "step" ? JSON.stringify(choice.add.step) : choice.key;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** The choices whose words hold every word typed, in their order; all of them when nothing is. */
export function matching(choices: readonly Choice[], query: string): Choice[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return choices.filter((choice) => {
    const text = `${choice.label} ${choice.group}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
