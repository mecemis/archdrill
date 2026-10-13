import type { Environment } from "@archdrill/model";
import type { Moments } from "./math/gamma";

export interface ComponentMetrics {
  readonly componentId: string;
  /** Requests per second arriving, split by whether they read or change data. */
  readonly readLoad: number;
  readonly writeLoad: number;
  readonly readCapacity: number;
  readonly writeCapacity: number;
  /** Combined utilisation (read share + write share); above 1 means overloaded. */
  readonly utilization: number;
  /** Utilisation of the shard that holds the hot key; equals `utilization` without one. */
  readonly hottestShardUtilization: number;
  /** Instances it runs in this environment, after autoscaling. */
  readonly instances: number;
  /** Share of arriving requests rejected because the component is overloaded. */
  readonly dropRate: number;
  /** Requests per second that are retries of failed attempts (included in the loads). */
  readonly retryLoad: number;
  /** The environment's faults on this component, for people; empty when healthy. */
  readonly faults: readonly string[];
  /** Latency added per visit (service + queueing), excluding the network. */
  readonly latency: Moments;
  /** The same at the shard that holds the hot key (equal to `latency` without one). */
  readonly hotLatency: Moments;
  /** Data stored, counting every copy. */
  readonly storageGb: number;
  readonly monthlyCost: number;
  readonly costBreakdown: {
    readonly instances: number;
    readonly requests: number;
    readonly storage: number;
  };
}

export interface CacheMetrics {
  readonly componentId: string;
  readonly entity: string;
  /** Hit ratio for keys that exist. */
  readonly hitRatio: number;
  /** Share of lookups for missing keys answered by a negative entry. */
  readonly negativeHitRatio: number;
  readonly capacityItems: number;
  readonly ttlSec: number | null;
  /** Whether any live step writes entries; without it the cache never warms. */
  readonly populated: boolean;
  /** Lookups per second for existing keys. */
  readonly lookupRate: number;
}

export interface LatencySummary {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface PathMetrics {
  readonly pathId: string;
  /** Share of the operation's requests that take this path. */
  readonly probability: number;
  readonly latency: LatencySummary;
}

export interface OperationMetrics {
  readonly operation: string;
  readonly rate: number;
  /** Share of requests that end with one of the operation's success statuses. */
  readonly successRate: number;
  /** Share of requests rejected before reaching the handler's steps. */
  readonly ingressRejectRate: number;
  /** Why requests did not succeed, as shares of all requests. */
  readonly failures: {
    /** Rejected by an overloaded component on the ingress route. */
    readonly rejected: number;
    /** Ended at an outcome the flow does not handle. */
    readonly unhandled: number;
    /** Answered with a status that is not a success for this operation (e.g. 503 after a rejected call). */
    readonly errorStatus: number;
  };
  /** Latency of successful requests; failed requests are reported by the success rate instead. */
  readonly latency: LatencySummary;
  readonly paths: readonly PathMetrics[];
}

/** What flow steps' calls over one connection experience, after the caller's policy. */
export interface ConnectionCallMetrics {
  readonly connectionId: string;
  /** Calls per second that flow steps make (first attempts). */
  readonly calls: number;
  /** Attempts per second leaving the caller, retries included. */
  readonly attempts: number;
  /** Share of calls that fail after retries and the circuit breaker. */
  readonly failure: number;
  /** Share of calls an open circuit breaker fails without calling. */
  readonly shortCircuit: number;
  /** Share of attempts the caller's bulkhead rejects. */
  readonly shed: number;
  /** Share of served attempts that come back after the caller's timeout. */
  readonly timedOut: number;
}

/** A component that a shock leaves overloaded for good, although it is healthy in steady state. */
export interface MetastableComponent {
  readonly componentId: string;
  /** Utilisation in the overloaded state the shock leads to. */
  readonly utilization: number;
  /** Requests per second reaching it there, and how many of them are retries. */
  readonly load: number;
  readonly retryLoad: number;
}

export interface EnvironmentMetrics {
  readonly environment: Environment;
  readonly operations: ReadonlyMap<string, OperationMetrics>;
  readonly components: ReadonlyMap<string, ComponentMetrics>;
  readonly caches: readonly CacheMetrics[];
  /**
   * Per entity, over requests for keys that exist and looked it up in a
   * cache: the share any cache tier answered. Each request counts once, so
   * layered caches (a near cache in front of a shared one) do not double count.
   */
  readonly entityHitRatios: ReadonlyMap<
    string,
    { readonly lookupRate: number; readonly hitRatio: number }
  >;
  /** Requests per second over each connection, retries included. */
  readonly connections: ReadonlyMap<string, number>;
  /** Per connection that flow steps call over: failures, retries, timeouts, shedding. */
  readonly calls: ReadonlyMap<string, ConnectionCallMetrics>;
  readonly monthlyCost: number;
  /** False if the overload feedback loop did not settle; metrics are then the last iterate. */
  readonly converged: boolean;
  readonly iterations: number;
  /** Components a shock (cold caches) tips into lasting overload that retries sustain; empty when none. */
  readonly metastable: readonly MetastableComponent[];
}
