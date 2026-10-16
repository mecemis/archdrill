import type { ComponentSelector, Timeline, TimelineEvent } from "@archdrill/model";
import { selectComponents, zoneLoss } from "./faults";
import type { LoopState } from "./propagate";
import { type CacheSpec, cacheKey, type SimulationContext } from "./setup";
import type { ComponentMetrics, OperationMetrics } from "./types";

/**
 * State that changes over a timeline at its own pace, between the steps the
 * fixed point solves: autoscalers, circuit breakers, cache contents and
 * backlogs (see ADR 0008).
 */

/** An autoscaler acts on the average utilisation over this window. */
export const AUTOSCALE_WINDOW_SEC = 30;
/** After scaling out, an autoscaler waits this long before it scales in. */
export const SCALE_IN_COOLDOWN_SEC = 300;
/** Start-up time of a new instance when the catalog does not say. */
export const DEFAULT_STARTUP_SEC = 60;
/** An open breaker fails calls for this long before it lets a trial call through. */
export const BREAKER_WAIT_SEC = 10;
/** A breaker that fails at least this share of calls counts as open. */
const BREAKER_OPEN = 0.5;
/** Scale out only for a meaningful shortfall, and scale in only for a clear surplus. */
const SCALE_OUT_MARGIN = 0.05;
const SCALE_IN_MARGIN = 0.5;

export type DynamicMarkKind =
  | "restart"
  | "scale-out"
  | "scale-in"
  | "breaker-open"
  | "breaker-close";

export interface DynamicMark {
  readonly at: number;
  readonly kind: DynamicMarkKind;
  readonly label: string;
  readonly componentIds: readonly string[];
}

const label = (ctx: SimulationContext, id: string) =>
  ctx.attempt.architecture.components.find((c) => c.id === id)?.label ?? id;

/**
 * Autoscaled services follow the average utilisation over a window. New
 * instances take traffic only after their start-up time; surplus instances
 * go once the cooldown after the last scale-out has passed.
 */
export function autoscalers(ctx: SimulationContext) {
  const components = ctx.attempt.architecture.components.filter((c) => c.autoscale);
  const startup = (id: string) => {
    const c = components.find((x) => x.id === id);
    return (c && ctx.catalog.flavor(c.kind, c.flavor)?.startupSec) ?? DEFAULT_STARTUP_SEC;
  };
  const pending = new Map<string, { readyAt: number; replicas: number }[]>();
  const history = new Map<string, { t: number; wanted: number }[]>();
  const lastScaleOut = new Map<string, number>();

  return {
    /** Brings instances whose start-up time has passed into service. */
    launchReady(t: number, loop: LoopState): DynamicMark[] {
      const marks: DynamicMark[] = [];
      for (const [id, launches] of pending) {
        const ready = launches.filter((l) => l.readyAt <= t);
        if (ready.length === 0) continue;
        const added = ready.reduce((sum, l) => sum + l.replicas, 0);
        const replicas = (loop.replicas.get(id) ?? 0) + added;
        loop.replicas.set(id, replicas);
        pending.set(
          id,
          launches.filter((l) => l.readyAt > t),
        );
        marks.push({
          at: t,
          kind: "scale-out",
          label: `${label(ctx, id)}: new instances take traffic (${Math.ceil(replicas - 1e-6)} running)`,
          componentIds: [id],
        });
      }
      return marks;
    },
    /** Decides from this step's utilisation whether to start or stop instances. */
    observe(t: number, metrics: ReadonlyMap<string, ComponentMetrics>, loop: LoopState) {
      const marks: DynamicMark[] = [];
      for (const component of components) {
        const bounds = component.autoscale;
        const c = metrics.get(component.id);
        if (!bounds || !c) continue;
        const running = loop.replicas.get(component.id) ?? component.replicas;
        // Work in instance-equivalents, measured on the instances actually running.
        const wanted = Math.min(
          bounds.max,
          Math.max(component.replicas, (c.utilization * c.instances) / bounds.targetUtilization),
        );
        const window = [...(history.get(component.id) ?? []), { t, wanted }].filter(
          (h) => h.t > t - AUTOSCALE_WINDOW_SEC,
        );
        history.set(component.id, window);
        const average = window.reduce((sum, h) => sum + h.wanted, 0) / window.length;
        const launches = pending.get(component.id) ?? [];
        const coming = launches.reduce((sum, l) => sum + l.replicas, 0);
        if (average > running + coming + SCALE_OUT_MARGIN) {
          const readyAt = t + startup(component.id);
          pending.set(component.id, [
            ...launches,
            { readyAt, replicas: average - running - coming },
          ]);
          lastScaleOut.set(component.id, t);
          if (launches.length === 0) {
            marks.push({
              at: t,
              kind: "scale-out",
              label: `${label(ctx, component.id)}: scaling out to ${Math.ceil(average - 1e-6)} instances, ready at ${readyAt} s`,
              componentIds: [component.id],
            });
          }
        } else if (
          coming === 0 &&
          average < running - SCALE_IN_MARGIN &&
          t - (lastScaleOut.get(component.id) ?? Number.NEGATIVE_INFINITY) >= SCALE_IN_COOLDOWN_SEC
        ) {
          loop.replicas.set(component.id, Math.max(component.replicas, average));
          marks.push({
            at: t,
            kind: "scale-in",
            label: `${label(ctx, component.id)}: scaling in to ${Math.ceil(average - 1e-6)} instances`,
            componentIds: [component.id],
          });
        }
      }
      return marks;
    },
  };
}

/**
 * A breaker that opens stays open for its wait, failing calls fast even if
 * the dependency recovers meanwhile; then trial calls decide whether it closes.
 */
export function breakers(ctx: SimulationContext) {
  const open = new Map<string, { until: number; share: number }>();
  const target = (connectionId: string) =>
    ctx.attempt.architecture.connections.find((c) => c.id === connectionId)?.to ?? "";
  return {
    /** Holds breakers whose wait is not over. */
    hold(t: number, loop: LoopState): void {
      loop.breakerHeld.clear();
      for (const [id, state] of open) if (t < state.until) loop.breakerHeld.set(id, state.share);
    },
    observe(t: number, shares: ReadonlyMap<string, number>): DynamicMark[] {
      const marks: DynamicMark[] = [];
      for (const [id, share] of shares) {
        const state = open.get(id);
        if (share >= BREAKER_OPEN && (!state || t >= state.until)) {
          if (!state) {
            marks.push({
              at: t,
              kind: "breaker-open",
              label: `Breaker to ${label(ctx, target(id))} opens`,
              componentIds: [target(id)],
            });
          }
          open.set(id, { until: t + BREAKER_WAIT_SEC, share });
        } else if (state && t >= state.until && share < BREAKER_OPEN) {
          open.delete(id);
          marks.push({
            at: t,
            kind: "breaker-close",
            label: `Breaker to ${label(ctx, target(id))} closes`,
            componentIds: [target(id)],
          });
        }
      }
      return marks;
    },
  };
}

type RestartEvent = Extract<TimelineEvent, { kind: "restart" }>;
type FaultEvent = Extract<TimelineEvent, { kind: "fault" }>;

/**
 * Caches start empty after a restart, and after a crash once they are back.
 * A cache that started empty `w` seconds ago holds only what was asked for
 * since. Without coalescing, requests for a key that arrive while its first
 * miss is still loading miss too, so the window starts one miss later.
 */
export function cacheRestarts(timeline: Timeline, ctx: SimulationContext) {
  const caches = (selector: ComponentSelector) =>
    selectComponents(selector, ctx.attempt, ctx.catalog).filter((c) =>
      ctx.catalog.capabilities(c.kind, c.flavor).has("volatile-kv"),
    );
  const emptied: { at: number; ids: string[]; label: string }[] = [];
  for (const event of timeline.events) {
    if (event.kind === "restart") {
      const restart = event as RestartEvent;
      emptied.push({
        at: restart.at,
        ids: caches(restart.target).map((c) => c.id),
        label: restart.label ?? "Restart",
      });
    }
    if (event.kind === "fault") {
      const { fault, until } = event as FaultEvent;
      if (until === undefined || (fault.kind !== "down" && fault.kind !== "zone-down")) continue;
      const ids =
        fault.kind === "down"
          ? caches(fault.target).map((c) => c.id)
          : // Caches that lost everything with the zone come back empty; the others keep theirs.
            caches({ capability: "volatile-kv" })
              .filter((c) => zoneLoss(c, ctx.catalog).capacityLeft === 0)
              .map((c) => c.id);
      if (ids.length > 0) emptied.push({ at: until, ids, label: "Back after the outage" });
    }
  }
  emptied.sort((a, b) => a.at - b.at);
  const startedAt = new Map<string, number>();
  let applied = 0;
  return {
    advance(t: number): DynamicMark[] {
      const marks: DynamicMark[] = [];
      while (applied < emptied.length && (emptied[applied]?.at ?? Number.POSITIVE_INFINITY) <= t) {
        const event = emptied[applied++];
        if (!event || event.ids.length === 0) continue;
        for (const id of event.ids) startedAt.set(id, event.at);
        marks.push({ at: event.at, kind: "restart", label: event.label, componentIds: event.ids });
      }
      return marks;
    },
    /** Seconds each restarted cache has been filling, after its first misses (by `cacheKey`). */
    windows(
      t: number,
      specs: readonly CacheSpec[],
      missLatencyMs: (entity: string) => number,
    ): Map<string, number> {
      const windows = new Map<string, number>();
      for (const spec of specs) {
        const started = startedAt.get(spec.componentId);
        if (started === undefined) continue;
        const loading = spec.coalesced ? 0 : missLatencyMs(spec.entity) / 1000;
        windows.set(cacheKey(spec.componentId, spec.entity), Math.max(0, t - started - loading));
      }
      return windows;
    },
  };
}

/**
 * Consumers and jobs that cannot keep up leave work waiting; once they have
 * capacity again, they work through it on top of new work.
 */
export function backlogs() {
  const waiting = new Map<string, number>();
  return {
    of: (operation: string) => waiting.get(operation) ?? 0,
    /** Items per second each one tries to clear in the next step. */
    drains(stepSec: number): Map<string, number> {
      return new Map(
        [...waiting].filter(([, n]) => n > 0).map(([id, n]) => [id, n / stepSec] as const),
      );
    },
    observe(
      operations: ReadonlyMap<string, OperationMetrics>,
      drains: ReadonlyMap<string, number>,
      stepSec: number,
    ): void {
      for (const [id, op] of operations) {
        if (op.trigger === "request") continue;
        const arrivals = op.rate - (drains.get(id) ?? 0);
        const processed = op.rate * (1 - op.ingressRejectRate);
        const next = (waiting.get(id) ?? 0) + (arrivals - processed) * stepSec;
        waiting.set(id, Math.max(0, next));
      }
    },
  };
}
