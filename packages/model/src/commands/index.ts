import { enablePatches, type Patch, produceWithPatches } from "immer";
import type { z } from "zod";
import type { Attempt } from "../attempt/schema";
import {
  addComponent,
  addConnection,
  moveComponent,
  removeComponent,
  removeConnection,
  reverseConnection,
  setAutoscale,
  setComponentData,
  setConnectionMode,
  setConnectionPolicy,
  setDecision,
  updateComponent,
} from "./architecture";
import {
  addStep,
  createFlow,
  linkOutcome,
  removeFlow,
  removeStep,
  setFlowHandler,
  setRoot,
  updateStep,
} from "./flows";

enablePatches();

/**
 * Every edit to an attempt goes through a named command. The same registry
 * drives the editor (with undo/redo from patches) and the mutant corpus.
 */
export const COMMANDS = {
  addComponent,
  removeComponent,
  updateComponent,
  setAutoscale,
  setComponentData,
  moveComponent,
  addConnection,
  removeConnection,
  reverseConnection,
  setConnectionMode,
  setConnectionPolicy,
  setDecision,
  createFlow,
  setFlowHandler,
  removeFlow,
  addStep,
  updateStep,
  linkOutcome,
  setRoot,
  removeStep,
} as const;

export type CommandName = keyof typeof COMMANDS;
export type CommandArgs<N extends CommandName> = z.input<(typeof COMMANDS)[N]["args"]>;
export type CommandReturn<N extends CommandName> = ReturnType<(typeof COMMANDS)[N]["run"]>;

export interface CommandResult<R> {
  readonly attempt: Attempt;
  readonly patches: Patch[];
  readonly inversePatches: Patch[];
  readonly result: R;
}

export function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}

/** Validates the arguments and applies the command immutably. Throws CommandError or ZodError. */
export function applyCommand<N extends CommandName>(
  attempt: Attempt,
  name: N,
  args: CommandArgs<N>,
): CommandResult<CommandReturn<N>> {
  const command = COMMANDS[name];
  const parsed = command.args.parse(args);
  let result: unknown;
  const [next, patches, inversePatches] = produceWithPatches(attempt, (draft) => {
    // biome-ignore lint/suspicious/noExplicitAny: the registry pairs each run with its own schema
    result = (command.run as (d: typeof draft, a: any) => unknown)(draft, parsed);
  });
  return { attempt: next, patches, inversePatches, result: result as CommandReturn<N> };
}

export { CommandError } from "./define";
export { type StepInput, StepInputSchema } from "./flows";
