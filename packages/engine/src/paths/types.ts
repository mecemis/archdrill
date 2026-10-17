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
  /** For publish steps: the event the message is about. */
  readonly event: string | undefined;
  /** For store reads: concurrent misses for a key share one read. */
  readonly coalesce?: boolean;
  /** For store reads: the read sees every acknowledged write (primary, majority or strong read). */
  readonly consistent?: boolean;
  /** For counts and totals in consumers: what arrives per key is summed over this window, then written once. */
  readonly aggregateSec?: number;
  /** For increments: each key's count is spread over this many rows. */
  readonly counterShards?: number;
  /** For publishes: the message goes to a local buffer and the request continues at once. */
  readonly fireAndForget?: boolean;
  /** For fire-and-forget publishes: messages held while the queue is unreachable. */
  readonly bufferSize?: number;
  /** The call is made once for each of the request's items of this count, in parallel. */
  readonly each?: string;
  /** For payments: repeats carry an idempotency key. */
  readonly idempotencyKey?: boolean;
  /** For publishes: written in the transaction of the store write before it, relayed afterwards. */
  readonly outbox?: boolean;
  /** For writes from a stream processor: committed with its checkpoints. */
  readonly exactlyOnce?: boolean;
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
