import type { Component, Timeline, TimelineEvent } from "@archdrill/model";
import { type FaultHit, failoverSecOf, failsOverWithZone, faultedComponents } from "./faults";
import type { SimulationContext } from "./setup";

export type FaultEvent = Extract<TimelineEvent, { kind: "fault" }>;

/** One fault on one component over part of a timeline: from `from` until `until` (exclusive). */
export interface FaultWindow extends FaultHit {
  /** The timeline event the fault comes from. */
  readonly event: FaultEvent;
  readonly from: number;
  readonly until: number | undefined;
  /** The end comes from the store's failover time, not from the event. */
  readonly failoverEnds: boolean;
}

/**
 * When each fault hits each component. A failover the event does not end
 * lasts as long as the store's failover takes, or to the end when no replica
 * can take over or the catalog does not say; a lost zone fails over the
 * primaries that were in it for as long, and then only its instances are
 * missing. Other faults last as the event says, or to the end.
 */
export function faultWindows(timeline: Timeline, ctx: SimulationContext): FaultWindow[] {
  return timeline.events
    .filter((e): e is FaultEvent => e.kind === "fault")
    .flatMap((event) =>
      faultedComponents(event.fault, ctx.attempt, ctx.catalog).flatMap((component) => {
        // A lost zone only fails over the stores whose primary it held.
        const failsOver =
          event.fault.kind !== "zone-down" || failsOverWithZone(component, ctx.catalog);
        return windowsOf(event, component, failsOver ? failoverSecOf(component, ctx.catalog) : 0);
      }),
    );
}

function windowsOf(
  event: FaultEvent,
  component: Component,
  failoverSec: number | undefined,
): FaultWindow[] {
  const hit = { event, fault: event.fault, component, from: event.at };
  // A store the provider fails over unseen opens and closes the failover at once.
  if (event.fault.kind === "failover" && event.until === undefined && failoverSec !== undefined) {
    return [{ ...hit, until: event.at + failoverSec, failoverEnds: true }];
  }
  if (event.fault.kind !== "zone-down" || !failoverSec) {
    return [{ ...hit, until: event.until, failoverEnds: false }];
  }
  const promoted = event.at + failoverSec;
  if (event.until !== undefined && event.until <= promoted) {
    return [{ ...hit, failingOver: true, until: event.until, failoverEnds: false }];
  }
  return [
    { ...hit, failingOver: true, until: promoted, failoverEnds: true },
    { ...hit, from: promoted, until: event.until, failoverEnds: false },
  ];
}

export function activeAt(window: FaultWindow, t: number): boolean {
  return window.from <= t && (window.until === undefined || t < window.until);
}
