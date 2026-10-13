/// <reference lib="webworker" />
import { evaluateAttempt } from "@archdrill/evaluator";
import type { Attempt } from "@archdrill/model";
import { activePack, catalogIndex } from "./content";

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
    const evaluation = evaluateAttempt(attempt, { ...activePack, catalog: catalogIndex });
    self.postMessage({ id, evaluation, durationMs: performance.now() - started });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
