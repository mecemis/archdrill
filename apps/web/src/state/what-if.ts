import { type BreakingPoint, type EnvironmentMetrics, MAX_TRAFFIC_FACTOR } from "@archdrill/engine";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { sameEvaluationInputs, shownEnvironment } from "./evaluation";
import { useAttemptStore } from "./store";
import { useUi } from "./ui-store";
import type { WhatIfReply, WhatIfRequest } from "./what-if.worker";
import { breakingPointOf, simulateWhatIf, type WhatIfQuestion } from "./what-if-compute";

/**
 * The range the traffic can be set to, as a multiple of the environment's own:
 * as far as the search for a breaking point goes, so any it finds can be shown.
 */
export const MIN_FACTOR = 0.25;
export const MAX_FACTOR = MAX_TRAFFIC_FACTOR;

export type Place = Omit<WhatIfQuestion, "factor">;

/** A request before it is numbered; distributes over the kinds, so each keeps its own fields. */
type Unnumbered<T> = T extends unknown ? Omit<T, "id"> : never;

interface WhatIfState {
  /** The environment's traffic times this; 1 shows the scenario's own load. */
  readonly factor: number;
  /** The latest what-if simulated, with the question it answers. */
  readonly result: {
    readonly question: WhatIfQuestion;
    readonly metrics: EnvironmentMetrics;
  } | null;
  /** The latest what-if could not be simulated. */
  readonly failed: boolean;
  /** The latest breaking point found, for the place it was found for. */
  readonly breaking: { readonly place: Place; readonly point: BreakingPoint | null } | null;
  readonly searching: boolean;
  setFactor: (factor: number) => void;
}

export const useWhatIf = create<WhatIfState>((set) => ({
  factor: 1,
  result: null,
  failed: false,
  breaking: null,
  searching: false,
  setFactor: (factor) => set({ factor: Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, factor)) }),
}));

export const samePlace = (a: Place, b: Place) =>
  a.scenarioId === b.scenarioId &&
  a.environmentId === b.environmentId &&
  sameEvaluationInputs(a.attempt, b.attempt);

function accept(reply: WhatIfReply, request: WhatIfRequest): void {
  if (request.kind === "simulate") {
    if (reply.kind === "simulate" && reply.metrics) {
      useWhatIf.setState({ result: { question: request, metrics: reply.metrics }, failed: false });
    } else {
      useWhatIf.setState({ failed: true });
    }
  } else if (reply.kind === "break") {
    useWhatIf.setState({ breaking: { place: request, point: reply.point }, searching: false });
  } else {
    useWhatIf.setState({ breaking: null, searching: false });
  }
}

/** Answers on the main thread, where there are no workers; a failure is an answer too. */
function answerHere(request: WhatIfRequest): WhatIfReply {
  try {
    return request.kind === "simulate"
      ? { id: request.id, kind: "simulate", metrics: simulateWhatIf(request) }
      : { id: request.id, kind: "break", point: breakingPointOf(request) };
  } catch (error) {
    return {
      id: request.id,
      kind: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Asks a worker of its own, or the main thread where there are no workers.
 * While a request runs, only the latest one waits: a dragged slider skips the
 * factors it passed through.
 */
function createRunner() {
  const local = (request: WhatIfRequest) => accept(answerHere(request), request);
  let worker: Worker | null = null;
  try {
    if (typeof Worker !== "undefined") {
      worker = new Worker(new URL("./what-if.worker.ts", import.meta.url), { type: "module" });
    }
  } catch {
    worker = null;
  }
  let nextId = 0;
  let running: WhatIfRequest | null = null;
  let queued: WhatIfRequest | null = null;
  const send = (request: WhatIfRequest) => {
    if (!worker) return local(request);
    running = request;
    worker.postMessage(request);
  };
  if (worker) {
    worker.onerror = (event) => {
      event.preventDefault();
      // The main thread answers from now on.
      worker = null;
      const failed = running;
      const next = queued;
      running = null;
      queued = null;
      if (failed) local(failed);
      if (next) local(next);
    };
    worker.onmessage = (event: MessageEvent<WhatIfReply>) => {
      const done = running;
      if (!done || event.data.id !== done.id) return;
      running = null;
      accept(event.data, done);
      const next = queued;
      queued = null;
      if (next) send(next);
    };
  }
  return (request: Unnumbered<WhatIfRequest>) => {
    const numbered = { ...request, id: ++nextId } as WhatIfRequest;
    if (running) queued = numbered;
    else send(numbered);
  };
}

/**
 * One runner per kind: a search for the breaking point (twenty or so
 * simulations) never holds up a dragged slider, nor is a search ever dropped
 * for a newer simulation.
 */
const runners: Partial<Record<WhatIfRequest["kind"], ReturnType<typeof createRunner>>> = {};

/** Asks for a what-if: a simulation at a multiple, or a search for the breaking point. */
export function requestWhatIf(request: Unnumbered<WhatIfRequest>): void {
  runners[request.kind] ??= createRunner();
  runners[request.kind]?.(request);
}

/** The place on screen: the attempt, the scenario and the environment shown. */
function currentPlace(): Place | null {
  const attempt = useAttemptStore.getState().attempt;
  const { scenarioId, environmentId: selected } = useUi.getState();
  const environmentId = shownEnvironment(scenarioId, selected);
  return environmentId ? { attempt, scenarioId, environmentId } : null;
}

/** Looks for the multiple of the shown environment's traffic at which the design first breaks. */
export function findBreakingPoint(): void {
  const place = currentPlace();
  if (!place) return;
  useWhatIf.setState({ searching: true });
  requestWhatIf({ kind: "break", ...place });
}

/** The breaking point found for what is on screen now; null when there is none, or it is stale. */
export function useBreakingPoint(): {
  readonly point: BreakingPoint | null;
  readonly found: boolean;
  readonly searching: boolean;
} {
  const attempt = useAttemptStore((s) => s.attempt);
  const scenarioId = useUi((s) => s.scenarioId);
  const selected = useUi((s) => s.environmentId);
  const breaking = useWhatIf((s) => s.breaking);
  const searching = useWhatIf((s) => s.searching);
  const environmentId = shownEnvironment(scenarioId, selected);
  const current =
    breaking !== null &&
    environmentId !== null &&
    samePlace(breaking.place, { attempt, scenarioId, environmentId });
  return { point: current ? breaking.point : null, found: current, searching };
}

/**
 * Keeps the what-if simulated: on a new factor, a new environment, or an edit
 * that changes what is simulated (moving nodes does not). A new scenario
 * starts at its own traffic.
 */
export function useWhatIfDriver(): void {
  const attempt = useAttemptStore((s) => s.attempt);
  const scenarioId = useUi((s) => s.scenarioId);
  const selected = useUi((s) => s.environmentId);
  const factor = useWhatIf((s) => s.factor);
  const environmentId = shownEnvironment(scenarioId, selected);
  const lastScenario = useRef(scenarioId);

  useEffect(() => {
    // A new scenario starts at its own traffic; its old multiple is not simulated.
    if (lastScenario.current !== scenarioId) {
      lastScenario.current = scenarioId;
      useWhatIf.getState().setFactor(1);
      return;
    }
    if (factor === 1 || environmentId === null) return;
    const last = useWhatIf.getState().result?.question;
    const question = { attempt, scenarioId, environmentId, factor };
    if (last && last.factor === factor && samePlace(last, question)) return;
    requestWhatIf({ kind: "simulate", ...question });
  }, [attempt, scenarioId, environmentId, factor]);
}
