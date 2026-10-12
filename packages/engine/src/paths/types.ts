import type { ActionId, LogicId } from "@archdrill/model";

export interface CallPathStep {
  readonly kind: "call";
  readonly stepId: string;
  readonly target: string;
  /** The target's component kind, so predicates can ask for a kind of component. */
  readonly targetKind: string;
  /** Connection from the handler to the target, or null if the topology lacks one. */
  readonly connectionId: string | null;
  readonly action: ActionId;
  readonly entity: string | undefined;
  readonly ttlSec: number | undefined;
  /** For batched allocation: ids per call. */
  readonly batchSize: number | undefined;
  readonly outcome: string;
}

export interface LogicPathStep {
  readonly kind: "logic";
  readonly stepId: string;
  readonly logic: LogicId;
  readonly outcome: string;
}

export type PathStep = CallPathStep | LogicPathStep;

export type PathTerminal =
  | { readonly kind: "respond"; readonly stepId: string; readonly status: number }
  /** An outcome with no handler: the request ends in an undefined state. */
  | { readonly kind: "unhandled"; readonly stepId: string; readonly outcome: string };

/** One way a request can travel through an operation's flow. */
export interface Path {
  /** Stable id: `${operation}#${index}`. */
  readonly id: string;
  readonly operation: string;
  readonly index: number;
  readonly steps: readonly PathStep[];
  readonly terminal: PathTerminal;
  /** Every component the request touches: the ingress route, then call targets in order. */
  readonly components: readonly string[];
  /** Every connection the request uses, in order. */
  readonly connections: readonly string[];
}
