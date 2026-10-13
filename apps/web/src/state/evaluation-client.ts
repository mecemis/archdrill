import type { AttemptEvaluation } from "@archdrill/evaluator";
import type { Attempt } from "@archdrill/model";
import type { EvaluationRequest } from "./evaluation.worker";

export type EvaluationReply =
  | {
      readonly id: number;
      readonly evaluation: AttemptEvaluation;
      readonly durationMs: number;
      readonly error?: undefined;
    }
  | { readonly id: number; readonly error: string };

export interface EvaluationClient {
  /**
   * Asks for an evaluation. While one runs, only the latest request waits:
   * edits made in between are skipped, since nobody will look at them.
   */
  request(attempt: Attempt): void;
}

/** Runs evaluations in a worker; null where workers are not available (tests, old browsers). */
export function createWorkerClient(onReply: (attempt: Attempt, reply: EvaluationReply) => void) {
  if (typeof Worker === "undefined") return null;
  const worker = new Worker(new URL("./evaluation.worker.ts", import.meta.url), {
    type: "module",
  });
  let nextId = 0;
  let running: { readonly id: number; readonly attempt: Attempt } | null = null;
  let queued: Attempt | null = null;
  const send = (attempt: Attempt) => {
    running = { id: ++nextId, attempt };
    const request: EvaluationRequest = running;
    worker.postMessage(request);
  };
  worker.onmessage = (event: MessageEvent<EvaluationReply>) => {
    if (!running || event.data.id !== running.id) return;
    const done = running.attempt;
    running = null;
    onReply(done, event.data);
    if (queued) {
      const next = queued;
      queued = null;
      send(next);
    }
  };
  const client: EvaluationClient = {
    request(attempt) {
      if (running) queued = attempt;
      else send(attempt);
    },
  };
  return client;
}
