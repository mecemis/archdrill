import type {
  Environment,
  Fault,
  Prediction,
  Timeline,
  TimelineEvent,
  Workload,
} from "@archdrill/model";
import type { CallPathStep } from "../paths/types";
import type { ComponentFault } from "./faults";
import { resolveFaultHits, resolveFaults, selectComponents } from "./faults";
import { internetTransferCosts } from "./internet";
import {
  buildFixtures,
  createModel,
  type Fixtures,
  MAX_ITERATIONS,
  type Model,
  profilesOf,
  propagateModel,
  solve,
  TOLERANCE,
  warmCaches,
} from "./model";
import { poolSpecs, withProxyHops } from "./pools";
import { emptyLoopState } from "./propagate";
import { activeActive, crossRegionShare, standbyCosts, withActiveStandby } from "./regions";
import {
  buildCacheSpecs,
  buildProfiles,
  type CacheSpec,
  cacheKey,
  occupancies,
  replicaAckMs,
  type SimulationContext,
  storedGb,
  wholeInstances,
} from "./setup";
import { summarizeCache, summarizeComponents, summarizeOperations } from "./summary";
import {
  autoscalers,
  backlogs,
  breakers,
  cacheRestarts,
  type DynamicMarkKind,
  regionTakeovers,
} from "./timeline-dynamics";
import { activeAt, type FaultEvent, type FaultWindow, faultWindows } from "./timeline-faults";
import type { ComponentMetrics, OperationMetrics } from "./types";
import {
  crossZoneCostByCaller,
  type RouteHops,
  routeHops,
  summarizeZoneTraffic,
  type ZoneRoute,
  zoneRoutes,
} from "./zone-traffic";

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
  /** Mean latency of a call to the component, queueing included. */
  readonly latencyMs: readonly number[];
  /** What the faults active at each step do to the component, as on the canvas. */
  readonly faults: readonly (readonly string[])[];
  /** Whether those faults fail or slow its calls, beyond costing capacity. */
  readonly faultDisrupts: readonly boolean[];
}

/** One way requests went at a step, with its share of all requests and its mean latency. */
export interface PathShare {
  readonly pathId: string;
  readonly share: number;
  readonly meanMs: number;
}

/** The answer a timeline gives to a prediction, and the value behind it. */
export interface PredictionAnswer {
  readonly value: number;
  readonly optionId: string;
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
    /** A store's replica has taken over the primary a lost zone held. */
    | "failed-over"
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
  /** Requests per second over each connection at each step. */
  readonly connections: ReadonlyMap<string, readonly number[]>;
  /** Per operation and step: the paths requests took that carry a visible share. */
  readonly paths: ReadonlyMap<string, readonly (readonly PathShare[])[]>;
  /** The right answer to each of the timeline's predictions, by prediction id. */
  readonly predictions: ReadonlyMap<string, PredictionAnswer>;
  /** Steps whose load model did not settle; their numbers are approximate. */
  readonly unsettledSteps: number;
}

/** Paths below this share of requests are left out of a step's path mix. */
const VISIBLE_PATH_SHARE = 1e-4;

/** How tightly steps after the first are solved: shares to within 1e-5. */
const STEP_TOLERANCE = 1e-5;
/**
 * Iterations a step after the first may take. A step that has not settled by
 * then is approximate either way, and the next step carries on from its state.
 */
const STEP_MAX_ITERATIONS = 40;

type LoadEvent = Extract<TimelineEvent, { kind: "load" }>;

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
      rates[operation] =
        event.curve === "exponential" && from > 0 && target > 0
          ? from * (target / from) ** progress
          : from + (target - from) * progress;
    }
  }
  return rates;
}

/** Step times from 0 to the duration, inclusive. */
function stepTimes(timeline: Timeline): number[] {
  const count = Math.floor(timeline.durationSec / timeline.stepSec + 1e-9);
  return Array.from({ length: count + 1 }, (_, k) => Number((k * timeline.stepSec).toFixed(6)));
}

/** When a failover the event leaves open is over: once every store it hits has failed over. */
function failoverEnd(windows: readonly FaultWindow[], event: FaultEvent): number | undefined {
  const ends = windows.filter((w) => w.event === event && w.failoverEnds).map((w) => w.until ?? 0);
  return event.fault.kind === "failover" && ends.length > 0 ? Math.max(...ends) : undefined;
}

function describeFault(fault: Fault): string {
  if (fault.kind === "zone-down") return "zone-down: every component";
  if (fault.kind === "region-down") return "region-down: the primary region";
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
  readonly traffic: ReadonlyMap<string, number>;
  readonly paths: ReadonlyMap<string, readonly PathShare[]>;
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
  // While both regions take traffic, the standby copies serve too; after a region is lost, one region's do.
  const bothServe = activeActive(workload, ctx.attempt);
  const doubled = bothServe
    ? { ...ctx, attempt: withActiveStandby(ctx.attempt, ctx.catalog) }
    : ctx;
  // A timeline loses the region at most once, for good (the schema rejects more, or an end).
  const lostAt = timeline.events.find(
    (e) => e.kind === "fault" && e.fault.kind === "region-down",
  )?.at;
  const twoRegionsAt = (t: number) => bothServe && (lostAt === undefined || t < lostAt);
  const designAt = (t: number) => (twoRegionsAt(t) ? doubled : ctx);
  const windows = faultWindows(timeline, ctx, bothServe);
  const segments = new Map<string, Segment>();
  const segmentFor = (active: readonly FaultWindow[], design: SimulationContext): Segment => {
    const key = `${design === doubled ? "2" : "1"}:${active.map((w) => windows.indexOf(w)).join(",")}`;
    const known = segments.get(key);
    if (known) return known;
    const faults = resolveFaultHits(active, ctx.catalog);
    const segment = {
      faults,
      caches: buildCacheSpecs(workload, buildProfiles(design, faults), design),
    };
    segments.set(key, segment);
    return segment;
  };
  const occupancy = occupancies(workload, ctx);
  const stored = storedGb(workload, ctx);
  const replicaAck = replicaAckMs(workload, ctx);
  const connections = ctx.attempt.architecture.connections;
  // Routes follow the instances autoscaled components run; the counts repeat from step to step.
  const routesByCount = new Map<
    string,
    { routes: Map<string, ZoneRoute>; hops: Map<string, RouteHops> }
  >();
  const routesFor = (replicas: ReadonlyMap<string, number>, design: SimulationContext) => {
    const running = new Map([...replicas].map(([id, r]) => [id, wholeInstances(r)]));
    const key = `${design === doubled ? "2" : "1"}:${[...running].map(([id, n]) => `${id}:${n}`).join(",")}`;
    const known = routesByCount.get(key);
    if (known) return known;
    const routes = zoneRoutes(design.attempt, ctx.catalog, running);
    const entry = { routes, hops: withProxyHops(routeHops(routes), poolSpecs(design)) };
    routesByCount.set(key, entry);
    return entry;
  };

  const times = stepTimes(timeline);
  // One state for the whole run: each step starts where the previous one ended.
  const loop = emptyLoopState();
  for (const c of designAt(0).attempt.architecture.components) {
    if (c.autoscale) loop.replicas.set(c.id, c.replicas);
  }
  const scaler = autoscalers(designAt(0));
  const breakerState = breakers(ctx);
  const restarts = cacheRestarts(timeline, ctx, bothServe);
  const takeovers = regionTakeovers(timeline, ctx, bothServe);
  const backlog = backlogs();
  // Latency of the stores behind caches, which sets how long a cold key's first miss takes.
  let missLatencyMs: (entity: string) => number = () => 0;
  const operations = new Map<string, OperationSeriesBuilder>();
  const components = new Map<
    string,
    {
      utilization: number[];
      instances: number[];
      latencyMs: number[];
      faults: (readonly string[])[];
      faultDisrupts: boolean[];
    }
  >();
  const trafficSeries = new Map<string, number[]>();
  const pathSeries = new Map<string, (readonly PathShare[])[]>();
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
      const end = event.until ?? failoverEnd(windows, event);
      if (end !== undefined && end <= timeline.durationSec) {
        marks.push({ at: end, kind: "fault-end", label, componentIds });
      }
    }
  }
  // Clients reach the standby region, and its stores are promoted one by one.
  for (const event of timeline.events) {
    if (event.kind !== "fault" || event.fault.kind !== "region-down") continue;
    const regional = windows.filter((w) => w.event === event);
    const redirected = regional.find(
      (w) => w.regionPhase === "redirecting" || w.regionPhase === "half-redirecting",
    );
    if (redirected?.until !== undefined && redirected.until <= timeline.durationSec) {
      marks.push({
        at: redirected.until,
        kind: "failed-over",
        label: "Clients reach the standby region",
        componentIds: regional
          .filter((w) => w.regionPhase === "redirecting" || w.regionPhase === "half-redirecting")
          .map((w) => w.component.id),
      });
    }
    for (const window of regional) {
      if (window.regionPhase !== "promoting" || window.until === undefined) continue;
      if (window.until > timeline.durationSec) continue;
      marks.push({
        at: window.until,
        kind: "failed-over",
        label: `${window.component.label} promoted in the standby region`,
        componentIds: [window.component.id],
      });
    }
  }
  // A lost zone stays lost, but the stores whose primaries it held fail over.
  for (const window of windows) {
    if (window.fault.kind !== "zone-down" || !window.failoverEnds) continue;
    if (window.until === undefined || window.until > timeline.durationSec) continue;
    marks.push({
      at: window.until,
      kind: "failed-over",
      label: `${window.component.label} failed over`,
      componentIds: [window.component.id],
    });
  }

  // A step with the same inputs whose state did not move repeats the last results.
  let previous: { inputs: string; summary: StepSummary } | null = null;

  times.forEach((t, step) => {
    marks.push(...restarts.advance(t));
    const design = designAt(t);
    scaler.serve(design.attempt);
    scaler.takeOver(takeovers.due(t), loop, bothServe);
    if (step > 0) marks.push(...scaler.launchReady(t, loop));
    breakerState.hold(t, loop);
    const active = windows.filter((w) => activeAt(w, t));
    const segment = segmentFor(active, design);
    const rates = ratesAt(timeline, t);
    const environment: Environment = {
      id: timeline.id,
      label: timeline.label,
      rates,
      connections: timeline.connections,
      classShares: timeline.classShares,
      faults: [...new Set(active.map((w) => w.fault))],
    };
    const base = buildFixtures(
      workload,
      environment,
      design,
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
      active.map((w) => windows.indexOf(w)),
      rates,
      [...fixtures.cacheWindows],
      [...drains],
      [...loop.replicas],
      [...loop.breakerHeld],
    ]);
    const model = createModel(fixtures, loop);
    // The design has been running before the timeline starts.
    if (step === 0) warmCaches(model, fixtures);
    // The first step is the steady state, solved as tightly as an environment;
    // later steps only need what a chart at this resolution can show.
    const solved =
      step === 0
        ? solve(model, fixtures, MAX_ITERATIONS, TOLERANCE)
        : solve(model, fixtures, STEP_MAX_ITERATIONS, STEP_TOLERANCE);
    if (!solved.converged) unsettledSteps++;
    const settledAlready = solved.converged && solved.iterations === 1;
    const summary =
      previous && settledAlready && previous.inputs === inputs
        ? previous.summary
        : summarizeStep(model, fixtures, design);
    previous = { inputs, summary };
    record(t, step, summary, drains);

    marks.push(...scaler.observe(t, summary.components, loop, takeovers.waiting(t)));
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

  function summarizeStep(model: Model, fixtures: Fixtures, design: SimulationContext): StepSummary {
    // Both regions serve this step: standby copies are billed as the component's own, and calls may cross.
    const serving = bothServe && design === doubled;
    const paths = new Map<string, PathShare[]>();
    const profiles = profilesOf(model, fixtures, true);
    const flow = propagateModel(model, fixtures);
    const { routes, hops } = routesFor(model.loop.replicas, design);
    const metrics = summarizeComponents(
      profiles,
      flow,
      model.loop.drop,
      stored,
      fixtures.faults,
      { ...ctx.problem.client, held: fixtures.clientConnections },
      crossZoneCostByCaller(summarizeZoneTraffic(flow.transfer, routes), ctx.attempt),
      standbyCosts(ctx.attempt, ctx.catalog, stored, flow, serving),
      internetTransferCosts(flow.toClients, ctx.attempt, ctx.catalog),
    );
    const summary = summarizeOperations(
      fixtures.operations,
      flow.operations,
      model.state,
      model.ingress.passThrough,
      {
        components: metrics,
        hops,
        ...(serving && {
          crossRegion: (callStep: CallPathStep) =>
            crossRegionShare(callStep, design.attempt, ctx.catalog),
        }),
        callFor: model.calls.get,
        replicaAck,
        timeoutOf: (callStep) =>
          connections.find((c) => c.id === callStep.connectionId)?.policy.timeoutMs,
        inProcess: new Set([...profiles].filter(([, p]) => p.inProcess).map(([id]) => id)),
        batchArrivals: flow.batchArrivals,
      },
      false,
      (operation, pathId, share, meanMs) => {
        if (share < VISIBLE_PATH_SHARE) return;
        const list = paths.get(operation) ?? [];
        list.push({ pathId, share, meanMs });
        paths.set(operation, list);
      },
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
    return {
      operations: summary,
      components: metrics,
      hitRatios,
      breakers: breakerShares,
      traffic: flow.traffic,
      paths: new Map([...paths].map(([op, list]) => [op, list.sort((a, b) => b.share - a.share)])),
    };
  }

  function record(
    t: number,
    step: number,
    { operations: summary, components: metrics, hitRatios, traffic, paths }: StepSummary,
    drains: ReadonlyMap<string, number>,
  ) {
    for (const connection of connections) {
      const series = trafficSeries.get(connection.id) ?? [];
      series.push(traffic.get(connection.id) ?? 0);
      trafficSeries.set(connection.id, series);
    }
    for (const id of new Set([...pathSeries.keys(), ...paths.keys()])) {
      const series = pathSeries.get(id) ?? Array.from({ length: step }, () => []);
      series.push(paths.get(id) ?? []);
      pathSeries.set(id, series);
    }
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
      const series = components.get(id) ?? {
        utilization: [],
        instances: [],
        latencyMs: [],
        faults: [],
        faultDisrupts: [],
      };
      const busiest = Math.max(c.utilization, c.hottestShardUtilization);
      series.utilization.push(busiest);
      series.instances.push(c.instances);
      series.latencyMs.push(c.latency.mean);
      series.faults.push(c.faults);
      series.faultDisrupts.push(c.faultDisrupts);
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
    connections: trafficSeries,
    paths: pathSeries,
    predictions: answerPredictions(timeline, times, operations, components, ctx),
    unsettledSteps,
  };
}

/** Measures each prediction on the finished timeline and picks the option its value falls in. */
function answerPredictions(
  timeline: Timeline,
  times: readonly number[],
  operations: ReadonlyMap<string, OperationSeriesBuilder>,
  components: ReadonlyMap<string, { utilization: readonly number[] }>,
  ctx: SimulationContext,
): Map<string, PredictionAnswer> {
  const answers = new Map<string, PredictionAnswer>();
  for (const prediction of timeline.predictions) {
    const value = measure(prediction.measure);
    const option =
      prediction.options.find((o) => o.below === undefined || value < o.below) ??
      prediction.options.at(-1);
    if (option) answers.set(prediction.id, { value, optionId: option.id });
  }
  return answers;

  function measure(m: Prediction["measure"]): number {
    if (m.kind === "peak-utilization") {
      const ids = selectComponents(m.target, ctx.attempt, ctx.catalog).map((c) => c.id);
      return Math.max(0, ...ids.flatMap((id) => components.get(id)?.utilization ?? []));
    }
    const series = operations.get(m.operation);
    if (!series) return m.kind === "lowest-success" ? 1 : 0;
    const judged = series.successRate.filter((_, i) => (series.rate[i] ?? 0) > 0);
    if (m.kind === "lowest-success") return Math.min(1, ...judged);
    // The first moment from which the success rate stays at the threshold.
    let recovered = Number.POSITIVE_INFINITY;
    for (let i = times.length - 1; i >= 0; i--) {
      const t = times[i] ?? 0;
      if (t < m.after) break;
      if ((series.rate[i] ?? 0) > 0 && (series.successRate[i] ?? 0) < m.threshold) break;
      recovered = t;
    }
    return recovered - m.after;
  }
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
