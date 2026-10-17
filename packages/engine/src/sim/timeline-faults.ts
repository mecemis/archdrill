import type { Component, Timeline, TimelineEvent } from "@archdrill/model";
import { type FaultHit, failoverSecOf, failsOverWithZone, faultedComponents } from "./faults";
import {
  hasStandby,
  REGION_DNS_FAILOVER_SEC,
  singleWriter,
  standbyWritesAt,
  takesClients,
} from "./regions";
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
 * missing. A lost region fails everything until DNS sends clients to the
 * standby region, where stores take writes once promoted. Other faults last
 * as the event says, or to the end.
 */
export function faultWindows(
  timeline: Timeline,
  ctx: SimulationContext,
  /** Both regions take traffic until one is lost. */
  active = false,
): FaultWindow[] {
  return timeline.events
    .filter((e): e is FaultEvent => e.kind === "fault")
    .flatMap((event) =>
      faultedComponents(event.fault, ctx.attempt, ctx.catalog).flatMap((component) => {
        if (event.fault.kind === "region-down") {
          return active
            ? activeRegionWindows(event, component, ctx)
            : regionWindows(event, component, ctx);
        }
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

/**
 * A lost region, for one component: down for good without a standby copy;
 * with one, down until clients reach the standby region, then taking reads
 * and, once its copy is promoted, writes. A lost region does not come back
 * (the schema rejects an end), so the last phase lasts to the end.
 */
function regionWindows(
  event: FaultEvent,
  component: Component,
  ctx: SimulationContext,
): FaultWindow[] {
  const hit = { event, fault: event.fault, component, failoverEnds: false };
  if (!hasStandby(component, ctx.catalog)) {
    return [{ ...hit, from: event.at, until: undefined }];
  }
  const redirected = event.at + REGION_DNS_FAILOVER_SEC;
  const writable = event.at + standbyWritesAt(component, ctx.catalog);
  const phases: FaultWindow[] = [
    { ...hit, regionPhase: "redirecting", from: event.at, until: redirected },
    { ...hit, regionPhase: "promoting", from: redirected, until: writable },
    { ...hit, from: writable, until: undefined },
  ];
  return phases.filter((w) => w.until === undefined || w.until > w.from);
}

/**
 * A lost region while both took traffic: the other region already serves
 * its own clients. Until DNS moves the lost region's clients, half of the
 * requests to the way in fail; a store with one primary takes no writes
 * from either region until its copy is promoted.
 */
function activeRegionWindows(
  event: FaultEvent,
  component: Component,
  ctx: SimulationContext,
): FaultWindow[] {
  const hit = { event, fault: event.fault, component, failoverEnds: false };
  if (!hasStandby(component, ctx.catalog)) {
    return [{ ...hit, from: event.at, until: undefined }];
  }
  const phases: FaultWindow[] = [];
  if (takesClients(component, ctx.attempt, ctx.catalog)) {
    const until = event.at + REGION_DNS_FAILOVER_SEC;
    phases.push({ ...hit, regionPhase: "half-redirecting", from: event.at, until });
  }
  if (singleWriter(component, ctx.catalog)) {
    const until = event.at + standbyWritesAt(component, ctx.catalog);
    phases.push({ ...hit, regionPhase: "promoting", from: event.at, until });
  }
  const settled = Math.max(event.at, ...phases.map((w) => w.until ?? event.at));
  return [...phases, { ...hit, from: settled, until: undefined }];
}

export function activeAt(window: FaultWindow, t: number): boolean {
  return window.from <= t && (window.until === undefined || t < window.until);
}
