/// <reference lib="webworker" />
import { catalogIndex, getProblemPack } from "@archdrill/content";
import { evaluateAttempt } from "@archdrill/evaluator";
import type { Attempt } from "@archdrill/model";

/**
 * Evaluates attempts off the main thread, so editing never waits for the
 * simulation. Replies carry the request id and how long the evaluation took.
 */
declare const self: DedicatedWorkerGlobalScope;

export interface EvaluationRequest {
  readonly id: number;
  readonly attempt: Attempt;
}

self.onmessage = (event: MessageEvent<EvaluationRequest>) => {
  const { id, attempt } = event.data;
  const started = performance.now();
  try {
    // The worker has no page address; the design says which problem it belongs to.
    const pack = getProblemPack(attempt.problemId);
    if (!pack) throw new Error(`Problem pack "${attempt.problemId}" is not available.`);
    const evaluation = evaluateAttempt(attempt, { ...pack, catalog: catalogIndex });
    self.postMessage({ id, evaluation, durationMs: performance.now() - started });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
