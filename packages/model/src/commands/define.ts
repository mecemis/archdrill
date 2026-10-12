import type { Draft } from "immer";
import type { z } from "zod";
import type { Attempt, Flow } from "../attempt/schema";

/** Thrown when a command cannot be applied; the message is shown to the user. */
export class CommandError extends Error {
  override readonly name = "CommandError";
}

export interface CommandDef<S extends z.ZodType, R> {
  readonly args: S;
  readonly run: (draft: Draft<Attempt>, args: z.output<S>) => R;
}

export function defineCommand<S extends z.ZodType, R>(
  args: S,
  run: (draft: Draft<Attempt>, args: z.output<S>) => R,
): CommandDef<S, R> {
  return { args, run };
}

/** First free id of the form `${prefix}${separator}${n}`, starting at 1. */
export function nextNumberedId(
  prefix: string,
  existing: Iterable<string>,
  separator = "-",
): string {
  const taken = new Set(existing);
  for (let n = 1; ; n++) {
    const candidate = `${prefix}${separator}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function requireFlow(draft: Draft<Attempt>, operation: string): Draft<Flow> {
  const flow = draft.flows.find((f) => f.operation === operation);
  if (!flow) throw new CommandError(`There is no flow for "${operation}" yet.`);
  return flow;
}

export function requireComponentIndex(draft: Draft<Attempt>, id: string): number {
  const index = draft.architecture.components.findIndex((c) => c.id === id);
  if (index < 0) throw new CommandError(`Component "${id}" does not exist.`);
  return index;
}
