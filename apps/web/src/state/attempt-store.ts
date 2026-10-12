import {
  type Attempt,
  applyCommand,
  type CommandArgs,
  type CommandName,
  type CommandReturn,
  emptyAttempt,
} from "@archdrill/model";
import { applyPatches, type Patch } from "immer";
import { ZodError } from "zod";
import { create } from "zustand";
import { useToasts } from "./toasts";

const MAX_HISTORY = 100;

interface HistoryEntry {
  readonly label: CommandName;
  readonly patches: Patch[];
  readonly inversePatches: Patch[];
}

export interface AttemptState {
  readonly attempt: Attempt;
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
  /** Applies a command; on failure shows the reason and returns undefined. */
  dispatch: <N extends CommandName>(name: N, args: CommandArgs<N>) => CommandReturn<N> | undefined;
  undo: () => void;
  redo: () => void;
  /** Replaces the whole attempt (load, reset) and clears history. */
  replace: (attempt: Attempt) => void;
}

/** A new attempt starts with a client, because every operation needs somewhere for traffic to come from. */
export function starterAttempt(problemId: string, problemVersion: number): Attempt {
  const result = applyCommand(emptyAttempt(problemId, problemVersion), "addComponent", {
    id: "visitors",
    kind: "client",
    flavor: "browser",
    label: "Visitors",
    position: { x: 0, y: 160 },
  });
  return result.attempt;
}

export function createAttemptStore(initial: Attempt) {
  return create<AttemptState>((set, get) => ({
    attempt: initial,
    past: [],
    future: [],
    dispatch(name, args) {
      try {
        const { attempt, patches, inversePatches, result } = applyCommand(
          get().attempt,
          name,
          args,
        );
        if (patches.length === 0) return result;
        const entry = { label: name, patches, inversePatches };
        set({ attempt, past: [...get().past, entry].slice(-MAX_HISTORY), future: [] });
        return result;
      } catch (error) {
        useToasts.getState().notify(describeError(error), "error");
        return undefined;
      }
    },
    undo() {
      const past = get().past;
      const entry = past[past.length - 1];
      if (!entry) return;
      set({
        attempt: applyPatches(get().attempt, entry.inversePatches),
        past: past.slice(0, -1),
        future: [entry, ...get().future],
      });
    },
    redo() {
      const [entry, ...rest] = get().future;
      if (!entry) return;
      set({
        attempt: applyPatches(get().attempt, entry.patches),
        past: [...get().past, entry],
        future: rest,
      });
    },
    replace(attempt) {
      set({ attempt, past: [], future: [] });
    },
  }));
}

function describeError(error: unknown): string {
  if (error instanceof ZodError) return error.issues[0]?.message ?? "Invalid input.";
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
