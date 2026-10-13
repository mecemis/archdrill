import type { Environment, Fault, Timeline, TimelineEvent, Workload } from "@archdrill/model";
import type { ComponentFault } from "./faults";
import { resolveFaults } from "./faults";
import {
  buildFixtures,
  createModel,
  type Fixtures,
  MAX_ITERATIONS,
  type Model,
  profilesOf,
  propagateModel,
  solve,
  warmCaches,
} from "./model";
import { emptyLoopState } from "./propagate";
import {
  buildCacheSpecs,
  buildProfiles,
  type CacheSpec,
  cacheKey,
  occupancies,
  replicaAckMs,
  type SimulationContext,
  storedGb,
} from "./setup";
import { summarizeCache, summarizeComponents, summarizeOperations } from "./summary";
import {
  autoscalers,
  backlogs,
  breakers,
  cacheRestarts,
  type DynamicMarkKind,
} from "./timeline-dynamics";
import type { ComponentMetrics, OperationMetrics } from "./types";

export interface OperationSeries {
  readonly trigger: OperationMetrics["trigger"];
  /** Requests (or items) per second at each step. */
  readonly rate: readonly number[];
  readonly successRate: readonly number[];
  readonly p50: readonly number[];
  readonly p99: readonly number[];
  /** Items waiting for consumers or jobs that fall behind, accumulated over the timeline. */
  readonly backlog: readonly number[];
}

export interface ComponentSeries {
  /** Utilisation of the busiest part: the whole tier, or its hottest shard. */
  readonly utilization: readonly number[];
  readonly instances: readonly number[];
}

/** Something worth marking on the timeline. */
export interface TimelineMark {
  readonly at: number;
  readonly kind:
    | "load"
    | "fault-start"
    | "fault-end"
    | "overload-start"
    | "overload-end"
    | DynamicMarkKind;
  readonly label: string;
  readonly componentIds: readonly string[];
}

export interface TimelineMetrics {
  readonly timeline: Timeline;
  /** Seconds since the start, one per step. */
  readonly times: readonly number[];
  readonly operations: ReadonlyMap<string, OperationSeries>;
  readonly components: ReadonlyMap<string, ComponentSeries>;
  /** Hit ratio per cache and entity, keyed `component|entity`. */
  readonly caches: ReadonlyMap<string, readonly number[]>;
  readonly marks: readonly TimelineMark[];
  /** Steps whose load model did not settle; their numbers are approximate. */
  readonly unsettledSteps: number;
}

type LoadEvent = Extract<TimelineEvent, { kind: "load" }>;
type FaultEvent = Extract<TimelineEvent, { kind: "fault" }>;

/** Rates at time `t`: events apply in order, each moving rates to its targets over its ramp. */
export function ratesAt(timeline: Timeline, t: number): Record<string, number> {
  const rates: Record<string, number> = { ...timeline.rates };
  const loads = timeline.events
    .filter((e): e is LoadEvent => e.kind === "load")
    .sort((a, b) => a.at - b.at);
  for (const event of loads) {
    if (t < event.at) break;
    const progress = event.rampSec > 0 ? Math.min(1, (t - event.at) / event.rampSec) : 1;
    for (const [operation, target] of Object.entries(event.rates)) {
      const from = rates[operation] ?? 0;
      rates[operation] = from + (target - from) * progress;
    }
  }
  return rates;
}

function activeAt(event: FaultEvent, t: number): boolean {
  return event.at <= t && (event.until === undefined || t < event.until);
}

/** Step times from 0 to the duration, inclusive. */
function stepTimes(timeline: Timeline): number[] {
  const count = Math.floor(timeline.durationSec / timeline.stepSec + 1e-9);
  return Array.from({ length: count + 1 }, (_, k) => Number((k * timeline.stepSec).toFixed(6)));
}

function describeFault(fault: Fault): string {
  const target = Object.entries(fault.target)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
  return `${fault.kind}: ${target}`;
}

interface StepSummary {
  readonly operations: ReadonlyMap<string, OperationMetrics>;
  readonly components: ReadonlyMap<string, ComponentMetrics>;
  readonly hitRatios: readonly { readonly key: string; readonly hitRatio: number }[];
  /** Per connection with a circuit breaker: share of calls it fails without calling. */
  readonly breakers: ReadonlyMap<string, number>;
}

interface Segment {
  readonly faults: ReadonlyMap<string, ComponentFault>;
  readonly caches: readonly CacheSpec[];
}

/**
 * How a design behaves over time. Each step re-solves loads, overload,
 * timeouts and latency for that moment's rates and faults, starting from the
 * previous step's state (see ADR 0008). Between steps, slower state moves on
 * its own: autoscalers launch instances that take time to start, breakers
 * stay open for their wait, restarted caches fill up, and backlogs build and
 * drain. With constant load and no events, it settles on the steady state
 * `simulateEnvironment` finds.
 */
export function simulateTimeline(
  workload: Workload,
  timeline: Timeline,
  ctx: SimulationContext,
): TimelineMetrics {
  const faultEvents = timeline.events.filter((e): e is FaultEvent => e.kind === "fault");
  const segments = new Map<string, Segment>();
  const segmentFor = (active: readonly FaultEvent[]): Segment => {
    const key = active.map((e) => faultEvents.indexOf(e)).join(",");
    const known = segments.get(key);
    if (known) return known;
    const faults = resolveFaults(
      active.map((e) => e.fault),
      ctx.attempt,
      ctx.catalog,
    );
    const segment = { faults, caches: buildCacheSpecs(workload, buildProfiles(ctx, faults), ctx) };
    segments.set(key, segment);
    return segment;
  };
  const occupancy = occupancies(workload, ctx);
  const stored = storedGb(workload, ctx);
  const replicaAck = replicaAckMs(workload, ctx);
  const connections = ctx.attempt.architecture.connections;

  const times = stepTimes(timeline);
  // One state for the whole run: each step starts where the previous one ended.
  const loop = emptyLoopState();
  for (const c of ctx.attempt.architecture.components) {
    if (c.autoscale) loop.replicas.set(c.id, c.replicas);
  }
  const scaler = autoscalers(ctx);
  const breakerState = breakers(ctx);
  const restarts = cacheRestarts(timeline, ctx);
  const backlog = backlogs();
  // Latency of the stores behind caches, which sets how long a cold key's first miss takes.
  let missLatencyMs: (entity: string) => number = () => 0;
  const operations = new Map<string, OperationSeriesBuilder>();
  const components = new Map<string, { utilization: number[]; instances: number[] }>();
  const caches = new Map<string, number[]>();
  const marks: TimelineMark[] = [];
  const overloaded = new Set<string>();
  let unsettledSteps = 0;

  for (const event of timeline.events) {
    if (event.kind === "load") {
      marks.push({
        at: event.at,
        kind: "load",
        label: event.label ?? "Load changes",
        componentIds: [],
      });
    } else if (event.kind === "fault") {
      const label = event.label ?? describeFault(event.fault);
      const componentIds = [...resolveFaults([event.fault], ctx.attempt, ctx.catalog).keys()];
      marks.push({ at: event.at, kind: "fault-start", label, componentIds });
      if (event.until !== undefined && event.until <= timeline.durationSec) {
        marks.push({ at: event.until, kind: "fault-end", label, componentIds });
      }
    }
  }

  // A step with the same inputs whose state did not move repeats the last results.
  let previous: { inputs: string; summary: StepSummary } | null = null;

  times.forEach((t, step) => {
    marks.push(...restarts.advance(t));
    if (step > 0) marks.push(...scaler.launchReady(t, loop));
    breakerState.hold(t, loop);
    const active = faultEvents.filter((e) => activeAt(e, t));
    const segment = segmentFor(active);
    const rates = ratesAt(timeline, t);
    const environment: Environment = {
      id: timeline.id,
      label: timeline.label,
      rates,
      classShares: timeline.classShares,
      faults: active.map((e) => e.fault),
    };
    const base = buildFixtures(
      workload,
      environment,
      ctx,
      segment.faults,
      segment.caches,
      occupancy,
    );
    const drains = backlog.drains(timeline.stepSec);
    const fixtures: Fixtures = {
      ...base,
      cacheWindows: restarts.windows(t, base.caches, missLatencyMs),
      drains,
      // The first step finds the steady state; after that the autoscalers decide.
      fixedReplicas: step > 0,
    };
    const inputs = JSON.stringify([
      active.map((e) => faultEvents.indexOf(e)),
      rates,
      [...fixtures.cacheWindows],
      [...drains],
      [...loop.replicas],
      [...loop.breakerHeld],
    ]);
    const model = createModel(fixtures, loop);
    // The design has been running before the timeline starts.
    if (step === 0) warmCaches(model, fixtures);
    const solved = solve(model, fixtures, MAX_ITERATIONS);
    if (!solved.converged) unsettledSteps++;
    const settledAlready = solved.converged && solved.iterations === 1;
    const summary =
      previous && settledAlready && previous.inputs === inputs
        ? previous.summary
        : summarizeStep(model, fixtures);
    previous = { inputs, summary };
    record(t, step, summary, drains);

    marks.push(...scaler.observe(t, summary.components, loop));
    marks.push(...breakerState.observe(t, summary.breakers));
    backlog.observe(summary.operations, drains, timeline.stepSec);
    missLatencyMs = missLatencyOf(summary.components);
  });

  /** For each entity, the mean latency of the slowest store that holds it. */
  function missLatencyOf(metrics: ReadonlyMap<string, ComponentMetrics>) {
    const byEntity = new Map<string, number>();
    for (const component of ctx.attempt.architecture.components) {
      const latency = metrics.get(component.id)?.latency.mean ?? 0;
      for (const { entity } of component.data) {
        byEntity.set(entity, Math.max(byEntity.get(entity) ?? 0, latency));
      }
    }
    return (entity: string) => byEntity.get(entity) ?? 0;
  }

  function summarizeStep(model: Model, fixtures: Fixtures): StepSummary {
    const profiles = profilesOf(model, fixtures, true);
    const flow = propagateModel(model, fixtures);
    const metrics = summarizeComponents(profiles, flow, model.loop.drop, stored, fixtures.faults);
    const summary = summarizeOperations(
      fixtures.operations,
      flow.operations,
      model.state,
      model.ingress.pass,
      {
        components: metrics,
        callFor: model.calls.get,
        replicaAck,
        timeoutOf: (callStep) =>
          connections.find((c) => c.id === callStep.connectionId)?.policy.timeoutMs,
        inProcess: new Set([...profiles].filter(([, p]) => p.inProcess).map(([id]) => id)),
        batchArrivals: flow.batchArrivals,
      },
      false,
    );
    const hitRatios = fixtures.caches.map((spec) => ({
      key: cacheKey(spec.componentId, spec.entity),
      hitRatio: summarizeCache(spec, flow, model.state).hitRatio,
    }));
    const breakerShares = new Map<string, number>();
    for (const connection of connections) {
      if (!connection.policy.circuitBreaker) continue;
      const tally = flow.calls.get(connection.id);
      breakerShares.set(
        connection.id,
        tally && tally.calls > 0 ? tally.shortCircuited / tally.calls : 0,
      );
    }
    return { operations: summary, components: metrics, hitRatios, breakers: breakerShares };
  }

  function record(
    t: number,
    step: number,
    { operations: summary, components: metrics, hitRatios }: StepSummary,
    drains: ReadonlyMap<string, number>,
  ) {
    for (const [id, op] of summary) {
      const series = operations.get(id) ?? emptyOperationSeries(op.trigger, step);
      // New work only; working through a backlog shows in the backlog series.
      series.rate.push(op.rate - (drains.get(id) ?? 0));
      series.successRate.push(op.successRate);
      series.p50.push(op.latency.p50);
      series.p99.push(op.latency.p99);
      series.backlog.push(backlog.of(id));
      operations.set(id, series);
    }
    for (const [id, c] of metrics) {
      const series = components.get(id) ?? { utilization: [], instances: [] };
      const busiest = Math.max(c.utilization, c.hottestShardUtilization);
      series.utilization.push(busiest);
      series.instances.push(c.instances);
      components.set(id, series);
      if (busiest > 1 && !overloaded.has(id)) {
        overloaded.add(id);
        marks.push({ at: t, kind: "overload-start", label: "Over capacity", componentIds: [id] });
      } else if (busiest <= 1 && overloaded.has(id)) {
        overloaded.delete(id);
        marks.push({
          at: t,
          kind: "overload-end",
          label: "Back under capacity",
          componentIds: [id],
        });
      }
    }
    for (const { key, hitRatio } of hitRatios) {
      const series = caches.get(key) ?? Array.from({ length: step }, () => Number.NaN);
      series.push(hitRatio);
      caches.set(key, series);
    }
    // Operations without traffic in this step, and caches not looked up, keep their place.
    for (const series of operations.values()) {
      if (series.rate.length > step) continue;
      series.rate.push(0);
      series.successRate.push(0);
      series.p50.push(0);
      series.p99.push(0);
      series.backlog.push(series.backlog.at(-1) ?? 0);
    }
    for (const series of caches.values()) {
      if (series.length <= step) series.push(Number.NaN);
    }
  }

  return {
    timeline,
    times,
    operations: new Map([...operations].map(([id, s]) => [id, s as OperationSeries])),
    components,
    caches,
    marks: marks.sort((a, b) => a.at - b.at),
    unsettledSteps,
  };
}

interface OperationSeriesBuilder {
  readonly trigger: OperationMetrics["trigger"];
  readonly rate: number[];
  readonly successRate: number[];
  readonly p50: number[];
  readonly p99: number[];
  readonly backlog: number[];
}

/** A series for an operation first seen at `step`: earlier steps had no traffic. */
function emptyOperationSeries(
  trigger: OperationMetrics["trigger"],
  step: number,
): OperationSeriesBuilder {
  const zeros = () => Array.from({ length: step }, () => 0);
  return {
    trigger,
    rate: zeros(),
    successRate: zeros(),
    p50: zeros(),
    p99: zeros(),
    backlog: zeros(),
  };
}
