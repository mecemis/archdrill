/// <reference lib="webworker" />
import type { BreakingPoint, EnvironmentMetrics } from "@archdrill/engine";
import { breakingPointOf, simulateWhatIf, type WhatIfQuestion } from "./what-if-compute";

/** Simulates a load other than the scenario's off the main thread, so dragging stays smooth. */
declare const self: DedicatedWorkerGlobalScope;

export type WhatIfRequest =
  | ({ readonly id: number; readonly kind: "simulate" } & WhatIfQuestion)
  | ({ readonly id: number; readonly kind: "break" } & Omit<WhatIfQuestion, "factor">);

export type WhatIfReply =
  | { readonly id: number; readonly kind: "simulate"; readonly metrics: EnvironmentMetrics | null }
  | { readonly id: number; readonly kind: "break"; readonly point: BreakingPoint | null }
  | { readonly id: number; readonly kind: "error"; readonly error: string };

self.onmessage = (event: MessageEvent<WhatIfRequest>) => {
  const request = event.data;
  try {
    const reply: WhatIfReply =
      request.kind === "simulate"
        ? { id: request.id, kind: "simulate", metrics: simulateWhatIf(request) }
        : { id: request.id, kind: "break", point: breakingPointOf(request) };
    self.postMessage(reply);
  } catch (error) {
    self.postMessage({
      id: request.id,
      kind: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
