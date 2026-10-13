import { ACTIONS, type Connection, DEFAULT_POLICY, type RequestClass } from "@archdrill/model";
import type { CallPathStep, Path, PathStep } from "../paths/types";
import { hotWindowShare, windowWriteShare } from "./aggregation";
import { bulkheadShed, type CallModel, callModel } from "./calls";
import { type ComponentFault, NO_FAULT } from "./faults";
import { aggregates, callCost, callShare, collectsBatch, type OutcomeState } from "./outcomes";
import { cacheKey, type OperationModel } from "./setup";
import {
  batchKey,
  type CallTally,
  type Load,
  type Propagation,
  pathProbability,
  type ResolvedOperation,
} from "./summary";

/** Quantities the fixed point iterates on, each relaxed with damping. */
export interface LoopState {
  /** Per component: share of calls for ordinary keys rejected by overload. */
  readonly drop: Map<string, number>;
  /** Per component: share of calls for the hot key rejected by its shard's overload. */
  readonly hotDrop: Map<string, number>;
  /** Per connection: share of served attempts that exceed the caller's timeout. */
  readonly timedOut: Map<string, number>;
  /** Per connection with a bulkhead: calls per second that flow steps make (first attempts). */
  readonly callRates: Map<string, number>;
  readonly hit: Map<string, number>;
  /** Hit ratio for the hot key, per cache and entity. */
  readonly hotHit: Map<string, number>;
  readonly negativeHit: Map<string, number>;
  /** Per autoscaled component: instances (replicas) it runs, continuous while iterating. */
  readonly replicas: Map<string, number>;
  /** Per connection: share of calls a breaker that opened recently keeps failing (timelines). */
  readonly breakerHeld: Map<string, number>;
}

export function emptyLoopState(): LoopState {
  return {
    drop: new Map(),
    hotDrop: new Map(),
    timedOut: new Map(),
    callRates: new Map(),
    hit: new Map(),
    hotHit: new Map(),
    negativeHit: new Map(),
    replicas: new Map(),
    breakerHeld: new Map(),
  };
}

export type CallFor = (step: CallPathStep, hotKey: boolean) => CallModel;

interface StepCall {
  readonly connection: string;
  readonly write: boolean;
  readonly keys: readonly [normal: string, hot: string];
}

/** Path steps never change, so what a step's call is keyed by is worked out once. */
const STEP_CALLS = new WeakMap<CallPathStep, StepCall>();

function stepCall(step: CallPathStep): StepCall {
  const known = STEP_CALLS.get(step);
  if (known) return known;
  const write = ACTIONS[step.action].effect !== "read";
  const connection = step.connectionId ?? `-${step.target}`;
  const prefix = `${connection}|${write ? "w" : "r"}`;
  const call: StepCall = { connection, write, keys: [`${prefix}|n`, `${prefix}|h`] };
  STEP_CALLS.set(step, call);
  return call;
}

/**
 * Call models per (connection, reads or writes, hot key or not), rebuilt
 * once per iteration from the current overload and timeout shares. A
 * bulkhead limits the whole connection; its shedding share is computed once
 * per iteration, from the risks of the first kind of call that asks.
 */
export function callModels(
  connections: readonly Connection[],
  faults: ReadonlyMap<string, ComponentFault>,
  loop: LoopState,
) {
  const policies = new Map(connections.map((c) => [c.id, c.policy]));
  const memo = new Map<string, CallModel>();
  const shedding = new Map<string, number>();
  const get: CallFor = (step, hotKey) => {
    const { connection, write, keys } = stepCall(step);
    const key = keys[hotKey ? 1 : 0];
    const cached = memo.get(key);
    if (cached) return cached;
    const fault = faults.get(step.target) ?? NO_FAULT;
    const policy = policies.get(connection) ?? DEFAULT_POLICY;
    const drops = hotKey ? loop.hotDrop : loop.drop;
    const risks = {
      fault: write ? fault.failWrite : fault.failRead,
      faultHangs: fault.hang,
      overload: drops.get(step.target) ?? 0,
      timeout: loop.timedOut.get(connection) ?? 0,
      heldOpen: loop.breakerHeld.get(connection) ?? 0,
    };
    const shed =
      shedding.get(connection) ?? bulkheadShed(risks, policy, loop.callRates.get(connection) ?? 0);
    shedding.set(connection, shed);
    const model = callModel({ ...risks, shed }, policy);
    memo.set(key, model);
    return model;
  };
  const shedOf = (connectionId: string | null) =>
    connectionId === null ? 0 : (shedding.get(connectionId) ?? 0);
  const reset = () => {
    memo.clear();
    shedding.clear();
  };
  return { get, shedOf, reset };
}

export type CallModels = ReturnType<typeof callModels>;

/**
 * How components on the way to the handler lose work: overload and faults.
 * A queue's deliveries are reads on the queue; every other hop counts as the
 * operation's class.
 */
export function ingressModel(faults: ReadonlyMap<string, ComponentFault>, loop: LoopState) {
  const overload = (id: string) => loop.drop.get(id) ?? 0;
  const lost = (id: string, write: boolean) => {
    const fault = faults.get(id) ?? NO_FAULT;
    return write ? fault.failWrite : fault.failRead;
  };
  const writes = (op: OperationModel, id: string) =>
    op.operation.trigger.type === "event" && op.analysis.ingress?.components[0] === id
      ? false
      : op.operation.class === "write";
  const pass = (op: OperationModel) =>
    op.ingress.reduce(
      (share, id) => share * (1 - overload(id)) * (1 - lost(id, writes(op, id))),
      1,
    );
  return { overload, lost, writes, pass };
}

export type IngressModel = ReturnType<typeof ingressModel>;

/**
 * Deliveries of a message whose processing keeps failing before the queue
 * moves it to a dead-letter queue. Failures are taken as correlated (a fault,
 * an overloaded dependency): a redelivered message fails again.
 */
export const MAX_DELIVERIES = 5;

type Published = Map<string, Map<string, { cls: RequestClass; rate: number }>>;

/**
 * A consumer receives the messages published about its event, with their
 * classes. Consumers and jobs that fell behind also work through their
 * backlog (`drain`, items per second), with the classes of new work.
 */
function resolveRate(
  op: OperationModel,
  published: Published,
  drain: number,
): { rate: number; classes: RequestClass[] } {
  const trigger = op.operation.trigger;
  if (trigger.type !== "event") return { rate: op.rate + drain, classes: [...op.classes] };
  const messages = [...(published.get(trigger.event)?.values() ?? [])];
  const rate = messages.reduce((sum, m) => sum + m.rate, 0);
  if (rate <= 0) return { rate: drain, classes: [] };
  return { rate: rate + drain, classes: messages.map((m) => ({ ...m.cls, share: m.rate / rate })) };
}

function succeeds(path: Path, op: OperationModel): boolean {
  return (
    path.terminal.kind === "respond" && op.operation.successStatuses.includes(path.terminal.status)
  );
}

type Lookups = { existing: number; absent: number; hot: number };

/**
 * Counts a request for an existing key once per entity it looked up in any
 * cache, and once more as a hit if any cache tier answered, however many
 * tiers it passed.
 */
function countEntityLookups(
  steps: readonly PathStep[],
  weight: number,
  into: Map<string, { lookups: number; hits: number }>,
): void {
  const looked = new Map<string, boolean>();
  for (const step of steps) {
    if (step.kind !== "call" || step.action !== "cache.get" || !step.entity) continue;
    if (step.outcome === "error") continue;
    looked.set(step.entity, (looked.get(step.entity) ?? false) || step.outcome === "hit");
  }
  for (const [entity, hit] of looked) {
    const entry = into.get(entity) ?? { lookups: 0, hits: 0 };
    into.set(entity, { lookups: entry.lookups + weight, hits: entry.hits + (hit ? weight : 0) });
  }
}

/** One pass of load propagation over every operation's paths and request classes. */
export function propagate(
  operations: readonly OperationModel[],
  state: OutcomeState,
  calls: CallModels,
  ingress: IngressModel,
  /** Backlog items per second that consumers and jobs work through on top of new work. */
  drains: ReadonlyMap<string, number> = new Map(),
): Propagation {
  const loads = new Map<string, Load>();
  const hotLoads = new Map<string, Load>();
  const batchedItems = new Map<string, Load>();
  const retries = new Map<string, number>();
  const lookups = new Map<string, Lookups>();
  const fills = new Map<string, { existing: number; hot: number }>();
  const traffic = new Map<string, number>();
  const tallies = new Map<string, CallTally>();
  const entityLookups = new Map<string, { lookups: number; hits: number }>();
  const add = (into: Map<string, Load>, id: string, rate: number, write: boolean) => {
    const load = into.get(id) ?? { read: 0, write: 0 };
    into.set(
      id,
      write ? { ...load, write: load.write + rate } : { ...load, read: load.read + rate },
    );
  };
  const addTraffic = (id: string | null, rate: number) => {
    if (id !== null) traffic.set(id, (traffic.get(id) ?? 0) + rate);
  };
  const tally = (id: string | null, more: CallTally) => {
    if (id === null) return;
    const t = tallies.get(id) ?? { calls: 0, attempts: 0, failed: 0, shortCircuited: 0 };
    tallies.set(id, {
      calls: t.calls + more.calls,
      attempts: t.attempts + more.attempts,
      failed: t.failed + more.failed,
      shortCircuited: t.shortCircuited + more.shortCircuited,
    });
  };

  const published: Published = new Map();
  const resolved = new Map<string, ResolvedOperation>();
  const batchArrivals = new Map<string, number>();
  const publish = (event: string, publisher: string, cls: RequestClass, rate: number) => {
    const byClass = published.get(event) ?? new Map();
    const key = `${publisher}/${cls.id}`;
    byClass.set(key, { cls, rate: (byClass.get(key)?.rate ?? 0) + rate });
    published.set(event, byClass);
  };

  for (const op of operations) {
    const { rate, classes } = resolveRate(op, published, drains.get(op.operation.id) ?? 0);
    const trigger = op.operation.trigger.type;
    let arriving = rate;
    const route = op.analysis.ingress;
    const enter = (id: string) => {
      const write = ingress.writes(op, id);
      const lost = ingress.lost(id, write);
      // Work routed to a failed node is not done there.
      add(loads, id, arriving * (1 - lost), write);
      arriving *= (1 - ingress.overload(id)) * (1 - lost);
    };
    // Work that starts inside the system enters at the first component on its
    // route: a queue delivers messages; a scheduled job starts in its handler.
    const entry = route?.components[0];
    if (trigger !== "request" && entry !== undefined && op.ingress.includes(entry)) enter(entry);
    route?.connections.forEach((connectionId, index) => {
      const hop = route.components[index + 1];
      addTraffic(connectionId, arriving);
      if (hop && op.ingress.includes(hop)) enter(hop);
    });
    let redelivered = 0;
    // Steps that sum per key over a window write one item (row) per key and window.
    const hotShare = classes.reduce((sum, c) => sum + (c.hotKey ? c.share : 0), 0);
    const itemsOf = (step: CallPathStep, hot: boolean) => {
      if (!aggregates(step)) return 1;
      return hot
        ? hotWindowShare(arriving * hotShare, step.aggregateSec)
        : windowWriteShare(arriving * (1 - hotShare), step.aggregateSec, op.keyPopularity);
    };
    for (const cls of classes) {
      for (const path of op.analysis.paths) {
        const once = arriving * cls.share * pathProbability(path, cls, state, op.unkeyed);
        if (once === 0) continue;
        const deliveries = trigger === "event" && !succeeds(path, op) ? MAX_DELIVERIES : 1;
        const weight = once * deliveries;
        redelivered += weight - once;
        if (cls.exists) countEntityLookups(path.steps, weight, entityLookups);
        for (const step of path.steps) {
          if (step.kind !== "call") continue;
          // A hot link makes its own rows hot, not rows keyed by something else.
          const hot = cls.hotKey && !op.unkeyed.has(step.stepId);
          const call = calls.get(step, hot);
          const failed = step.outcome === "error";
          const perCall = failed ? call.attemptsOnFailure : call.attemptsOnSuccess;
          const items = itemsOf(step, hot);
          const callRate = weight * items * callShare(step);
          const attempts = callRate * perCall;
          const write = ACTIONS[step.action].effect !== "read";
          const reach = failed ? call.reachOnFailure : call.reachOnSuccess;
          const work = attempts * reach * callCost(step);
          add(loads, step.target, work, write);
          if (collectsBatch(step)) {
            const carried = attempts * reach * (step.batchSize ?? 1);
            add(batchedItems, step.target, carried - work, write);
          }
          // A key spread over counter shards loads each of them with its share.
          if (hot) add(hotLoads, step.target, work / (step.counterShards ?? 1), write);
          retries.set(
            step.target,
            (retries.get(step.target) ?? 0) + callRate * Math.max(0, perCall - 1) * reach,
          );
          addTraffic(step.connectionId, attempts * (1 - calls.shedOf(step.connectionId)));
          // A fire-and-forget message the queue cannot take is lost, not failed back to the request.
          const lost = step.fireAndForget ? call.failure : 0;
          tally(step.connectionId, {
            calls: callRate,
            attempts,
            failed: failed ? callRate : callRate * lost,
            shortCircuited:
              failed && call.failure > 0 ? (callRate * call.shortCircuit) / call.failure : 0,
          });
          if (collectsBatch(step)) {
            const key = batchKey(op.operation.id, step.stepId);
            batchArrivals.set(key, (batchArrivals.get(key) ?? 0) + weight * items);
          }
          if (step.action === "queue.publish" && step.event && !failed) {
            publish(step.event, op.operation.id, cls, weight * (1 - lost));
          }
          // Entries only exist once a flow writes them: count the writes that land.
          if (ACTIONS[step.action].effect === "populate" && !failed) {
            if (state.exists(step.entity, cls)) {
              const key = cacheKey(step.target, step.entity);
              const entry = fills.get(key) ?? { existing: 0, hot: 0 };
              fills.set(
                key,
                hot
                  ? { ...entry, hot: entry.hot + weight }
                  : { ...entry, existing: entry.existing + weight },
              );
            }
          }
          // A lookup that never reached the cache does not warm or age its entries.
          if (step.action === "cache.get" && !failed) {
            const key = cacheKey(step.target, step.entity);
            const entry = lookups.get(key) ?? { existing: 0, absent: 0, hot: 0 };
            const exists = state.exists(step.entity, cls);
            lookups.set(key, {
              existing: entry.existing + (exists && !hot ? weight : 0),
              absent: entry.absent + (exists ? 0 : weight),
              hot: entry.hot + (exists && hot ? weight : 0),
            });
          }
        }
      }
    }
    // Redelivered messages pass the queue and the handler again.
    if (redelivered > 0) {
      for (const id of op.ingress) add(loads, id, redelivered, ingress.writes(op, id));
      for (const connectionId of route?.connections ?? []) addTraffic(connectionId, redelivered);
    }
    resolved.set(op.operation.id, { rate, classes, redeliveries: redelivered });
  }
  return {
    loads,
    hotLoads,
    retries,
    lookups,
    fills,
    traffic,
    calls: tallies,
    entityLookups,
    operations: resolved,
    batchArrivals,
    batchedItems,
  };
}
