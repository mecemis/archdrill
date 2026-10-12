import { ACTIONS, type Connection, DEFAULT_POLICY } from "@archdrill/model";
import type { CallPathStep } from "../paths/types";
import { bulkheadShed, type CallModel, callModel } from "./calls";
import { type ComponentFault, NO_FAULT } from "./faults";
import { callShare, type OutcomeState } from "./outcomes";
import { cacheKey, type OperationModel } from "./setup";
import { type CallTally, type Load, type Propagation, pathProbability } from "./summary";

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
  };
}

export type CallFor = (step: CallPathStep, hotKey: boolean) => CallModel;

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
    const write = ACTIONS[step.action].effect !== "read";
    const connection = step.connectionId ?? `-${step.target}`;
    const key = `${connection}|${write ? "w" : "r"}|${hotKey ? "h" : "n"}`;
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

/** How ingress hops lose requests: overload and faults on the components along the route. */
export function ingressModel(faults: ReadonlyMap<string, ComponentFault>, loop: LoopState) {
  const overload = (id: string) => loop.drop.get(id) ?? 0;
  const lost = (id: string, write: boolean) => {
    const fault = faults.get(id) ?? NO_FAULT;
    return write ? fault.failWrite : fault.failRead;
  };
  const pass = (op: OperationModel) => {
    const write = op.operation.class === "write";
    return op.ingress.reduce((share, id) => share * (1 - overload(id)) * (1 - lost(id, write)), 1);
  };
  return { overload, lost, pass };
}

export type IngressModel = ReturnType<typeof ingressModel>;

type Lookups = { existing: number; absent: number; hot: number };

/** One pass of load propagation over every operation's paths and request classes. */
export function propagate(
  operations: readonly OperationModel[],
  state: OutcomeState,
  calls: CallModels,
  ingress: IngressModel,
): Propagation {
  const loads = new Map<string, Load>();
  const hotLoads = new Map<string, Load>();
  const retries = new Map<string, number>();
  const lookups = new Map<string, Lookups>();
  const traffic = new Map<string, number>();
  const tallies = new Map<string, CallTally>();
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

  for (const op of operations) {
    const isWrite = op.operation.class === "write";
    let arriving = op.rate;
    const route = op.analysis.ingress;
    route?.connections.forEach((connectionId, index) => {
      const hop = route.components[index + 1];
      addTraffic(connectionId, arriving);
      if (hop && op.ingress.includes(hop)) {
        const lost = ingress.lost(hop, isWrite);
        // Requests routed to a failed node do no work there.
        add(loads, hop, arriving * (1 - lost), isWrite);
        arriving *= (1 - ingress.overload(hop)) * (1 - lost);
      }
    });
    for (const cls of op.classes) {
      for (const path of op.analysis.paths) {
        const weight = arriving * cls.share * pathProbability(path, cls, state);
        if (weight === 0) continue;
        for (const step of path.steps) {
          if (step.kind !== "call") continue;
          const call = calls.get(step, cls.hotKey);
          const failed = step.outcome === "error";
          const perCall = failed ? call.attemptsOnFailure : call.attemptsOnSuccess;
          const callRate = weight * callShare(step);
          const attempts = callRate * perCall;
          const write = ACTIONS[step.action].effect !== "read";
          const reach = failed ? call.reachOnFailure : call.reachOnSuccess;
          add(loads, step.target, attempts * reach, write);
          if (cls.hotKey) add(hotLoads, step.target, attempts * reach, write);
          retries.set(
            step.target,
            (retries.get(step.target) ?? 0) + callRate * Math.max(0, perCall - 1) * reach,
          );
          addTraffic(step.connectionId, attempts * (1 - calls.shedOf(step.connectionId)));
          tally(step.connectionId, {
            calls: callRate,
            attempts,
            failed: failed ? callRate : 0,
            shortCircuited:
              failed && call.failure > 0 ? (callRate * call.shortCircuit) / call.failure : 0,
          });
          // A lookup that never reached the cache does not warm or age its entries.
          if (step.action === "cache.get" && !failed) {
            const key = cacheKey(step.target, step.entity);
            const entry = lookups.get(key) ?? { existing: 0, absent: 0, hot: 0 };
            lookups.set(key, {
              existing: entry.existing + (cls.exists && !cls.hotKey ? weight : 0),
              absent: entry.absent + (cls.exists ? 0 : weight),
              hot: entry.hot + (cls.exists && cls.hotKey ? weight : 0),
            });
          }
        }
      }
    }
  }
  return { loads, hotLoads, retries, lookups, traffic, calls: tallies };
}
