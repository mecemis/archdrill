import type { ConnectionPolicy } from "@archdrill/model";
import type { Moments } from "./math/gamma";

/**
 * Round trip of a hop the design does not place in zones: a client's on its
 * way in, a call to a regional service, and the answer a rejected or refused
 * attempt waits for. Calls between components the design places take the
 * round trip of their zones instead (zone-traffic.ts).
 */
export const NETWORK_RTT_MS = 0.5;
/** Wait before the first retry with exponential backoff; it doubles after every attempt. */
export const BACKOFF_BASE_MS = 10;
/** How long a hung call waits when the caller sets no timeout: a common client default. */
export const NO_TIMEOUT_WAIT_MS = 30_000;
/**
 * A circuit breaker starts opening when this share of attempts fails and is
 * fully open at BREAKER_FULL_OPEN. The ramp stands for the share of time a
 * real breaker spends open; a hard switch would flap in a steady-state model.
 */
export const BREAKER_THRESHOLD = 0.5;
const BREAKER_FULL_OPEN = 0.75;

const ZERO: Moments = { mean: 0, variance: 0 };

/**
 * Why calls fail. A fault takes out part of the target for good (a dead
 * node's keys): every attempt of a call whose key lives there fails, so
 * retrying does not help. The other risks hit attempts independently.
 */
export interface AttemptRisks {
  /** Rejected by the caller's bulkhead; the attempt never leaves the caller. */
  readonly shed: number;
  /** Share of calls whose key a fault has taken out. */
  readonly fault: number;
  /** The fault hangs instead of refusing the connection. */
  readonly faultHangs: boolean;
  /** Rejected by the overloaded target. */
  readonly overload: number;
  /** Served, but after the caller's timeout. */
  readonly timeout: number;
  /** Share of calls a breaker that opened recently still fails, until its wait is over. */
  readonly heldOpen?: number;
}

/** What a policy-governed call to a dependency does, averaged over calls. */
export interface CallModel {
  /** Chance that one attempt to a working part of the target fails (shed, overload, timeout). */
  readonly attemptFailure: number;
  /** Chance that the call fails after its retries and the circuit breaker. */
  readonly failure: number;
  /** Share of calls the open circuit breaker fails without calling. */
  readonly shortCircuit: number;
  /** Expected attempts of a call that ends in success, and of one that fails. */
  readonly attemptsOnSuccess: number;
  readonly attemptsOnFailure: number;
  /**
   * Share of a call's attempts that reach a working part of the target (not
   * shed, not sent to a failed part), for calls that succeed and that fail.
   */
  readonly reachOnSuccess: number;
  readonly reachOnFailure: number;
  /** Latency that failed attempts and backoff add before a success. */
  readonly successExtra: Moments;
  /** Latency of a call that fails, from its attempts and backoff or an immediate short circuit. */
  readonly failureLatency: Moments;
}

export const HEALTHY_CALL: CallModel = {
  attemptFailure: 0,
  failure: 0,
  shortCircuit: 0,
  attemptsOnSuccess: 1,
  attemptsOnFailure: 1,
  reachOnSuccess: 1,
  reachOnFailure: 1,
  successExtra: ZERO,
  failureLatency: ZERO,
};

interface Weighted {
  readonly weight: number;
  readonly mean: number;
  readonly variance: number;
}

/** Moments of a mixture; weights need not sum to 1. */
function mixture(parts: readonly Weighted[]): Moments {
  const total = parts.reduce((sum, p) => sum + p.weight, 0);
  if (total <= 0) return ZERO;
  const mean = parts.reduce((sum, p) => sum + p.weight * p.mean, 0) / total;
  const second = parts.reduce((sum, p) => sum + p.weight * (p.variance + p.mean ** 2), 0) / total;
  return { mean, variance: Math.max(0, second - mean ** 2) };
}

/** Chance that one attempt to a working part of the target fails. */
const independentFailure = (risks: Omit<AttemptRisks, "fault" | "faultHangs">) =>
  1 - (1 - risks.shed) * (1 - risks.overload) * (1 - risks.timeout);

/** Cost of one failed attempt to a working part of the target, by why it failed. */
function liveAttemptCost(risks: AttemptRisks, policy: ConnectionPolicy): Moments {
  const wait = policy.timeoutMs ?? NO_TIMEOUT_WAIT_MS;
  const overload = (1 - risks.shed) * risks.overload;
  const timeout = (1 - risks.shed) * (1 - risks.overload) * risks.timeout;
  return mixture([
    { weight: risks.shed, mean: 0, variance: 0 },
    { weight: overload, mean: NETWORK_RTT_MS, variance: 0 },
    { weight: timeout, mean: wait, variance: 0 },
  ]);
}

/** Cost of one attempt to a failed part: shed locally, or refused or hung there. */
function deadAttemptCost(risks: AttemptRisks, policy: ConnectionPolicy): Moments {
  const wait = policy.timeoutMs ?? NO_TIMEOUT_WAIT_MS;
  return mixture([
    { weight: risks.shed, mean: 0, variance: 0 },
    { weight: 1 - risks.shed, mean: risks.faultHangs ? wait : NETWORK_RTT_MS, variance: 0 },
  ]);
}

/** Total backoff before attempt number `failures` (after that many failed attempts). */
function backoffBefore(failures: number, policy: ConnectionPolicy): Moments {
  if (policy.backoff === "none") return ZERO;
  let mean = 0;
  let variance = 0;
  for (let j = 0; j < failures; j++) {
    const ceiling = BACKOFF_BASE_MS * 2 ** j;
    // Full jitter waits a uniform time up to the ceiling.
    mean += policy.jitter ? ceiling / 2 : ceiling;
    variance += policy.jitter ? ceiling ** 2 / 12 : 0;
  }
  return { mean, variance };
}

/**
 * Share of calls an open breaker fails at once. A breaker counts failures
 * that come back from the dependency; the caller's own bulkhead rejections
 * say nothing about the dependency's health. It is one breaker per
 * connection, so a failure of one shard counts against all of them.
 */
function breakerOpenShare(risks: AttemptRisks, policy: ConnectionPolicy): number {
  if (!policy.circuitBreaker) return 0;
  const downstream = 1 - (1 - risks.fault) * (1 - risks.overload) * (1 - risks.timeout);
  const ramp = (downstream - BREAKER_THRESHOLD) / (BREAKER_FULL_OPEN - BREAKER_THRESHOLD);
  return Math.min(1, Math.max(0, ramp, risks.heldOpen ?? 0));
}

/** Expected attempts per call that passes the breaker. */
function attemptsPerCall(fault: number, e: number, retries: number): number {
  let live = 0;
  for (let k = 0; k <= retries; k++) live += e ** k;
  return fault * (retries + 1) + (1 - fault) * live;
}

/** Rounds of the inner fixed point between shedding and the retries it causes. */
const SHED_ROUNDS = 30;

/**
 * Share of attempts a bulkhead rejects. It is a hard limit on what passes
 * the circuit breaker, so it is computed from the current call rate rather
 * than relaxed over iterations; rejected attempts are retried like any
 * failure, which raises the offered rate, hence the small fixed point.
 */
export function bulkheadShed(
  risks: Omit<AttemptRisks, "shed">,
  policy: ConnectionPolicy,
  callsPerSec: number,
): number {
  const limit = policy.maxRps;
  if (limit === undefined || callsPerSec <= 0) return 0;
  const passing = callsPerSec * (1 - breakerOpenShare({ ...risks, shed: 0 }, policy));
  let shed = 0;
  for (let round = 0; round < SHED_ROUNDS; round++) {
    const e = independentFailure({ ...risks, shed });
    const offered = passing * attemptsPerCall(risks.fault, e, policy.retries);
    const next = offered > limit ? 1 - limit / offered : 0;
    if (Math.abs(next - shed) < 1e-12) return next;
    shed = next;
  }
  return shed;
}

/**
 * Combines the risks of a call with the caller's retries and circuit
 * breaker. A call whose key a fault took out fails every attempt; otherwise
 * attempts fail independently, and a call is retried up to
 * `policy.retries` times after failed attempts, with backoff between them.
 */
export function callModel(risks: AttemptRisks, policy: ConnectionPolicy): CallModel {
  const f = risks.fault;
  const e = independentFailure(risks);
  // A breaker still open from earlier failures fails calls to a healthy dependency too.
  const held = policy.circuitBreaker && (risks.heldOpen ?? 0) > 0;
  if (f <= 0 && e <= 0 && !held) return HEALTHY_CALL;
  const attempts = policy.retries + 1;
  const live = liveAttemptCost(risks, policy);
  const backoffAll = backoffBefore(attempts - 1, policy);
  const failedAfter = (cost: Moments): Moments => ({
    mean: attempts * cost.mean + backoffAll.mean,
    variance: attempts * cost.variance + backoffAll.variance,
  });

  // Calls to working keys that succeed after k failed attempts, k = 0..retries.
  const successes: Weighted[] = [];
  let attemptsOnSuccess = 0;
  for (let k = 0; k < attempts && e < 1; k++) {
    const weight = e ** k * (1 - e);
    const backoff = backoffBefore(k, policy);
    successes.push({
      weight,
      mean: k * live.mean + backoff.mean,
      variance: k * live.variance + backoff.variance,
    });
    attemptsOnSuccess += weight * (k + 1);
  }
  const liveFailsAll = e ** attempts;
  const succeeds = 1 - liveFailsAll;
  const perSuccess = succeeds > 0 ? attemptsOnSuccess / succeeds : 1;
  // Failed attempts to working keys that still reached them (timed out or rejected there).
  const reachedWhenFailing = e > 0 ? (e - risks.shed) / e : 0;

  const open = breakerOpenShare(risks, policy);
  const callsFailing = f + (1 - f) * liveFailsAll;
  const failure = open + (1 - open) * callsFailing;
  return {
    attemptFailure: e,
    failure,
    shortCircuit: open,
    attemptsOnSuccess: perSuccess,
    attemptsOnFailure: failure > 0 ? ((1 - open) * callsFailing * attempts) / failure : attempts,
    reachOnSuccess: (1 + (perSuccess - 1) * reachedWhenFailing) / perSuccess,
    reachOnFailure:
      callsFailing > 0 ? ((1 - f) * liveFailsAll * reachedWhenFailing) / callsFailing : 0,
    successExtra: mixture(successes),
    failureLatency: mixture([
      { weight: open, mean: 0, variance: 0 },
      { weight: (1 - open) * f, ...failedAfter(deadAttemptCost(risks, policy)) },
      { weight: (1 - open) * (1 - f) * liveFailsAll, ...failedAfter(live) },
    ]),
  };
}
