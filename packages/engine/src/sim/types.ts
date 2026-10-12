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
  /** Share of arriving requests rejected because the component is overloaded. */
  readonly dropRate: number;
  /** Latency added per visit (service + queueing), excluding the network. */
  readonly latency: Moments;
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

export interface EnvironmentMetrics {
  readonly environment: Environment;
  readonly operations: ReadonlyMap<string, OperationMetrics>;
  readonly components: ReadonlyMap<string, ComponentMetrics>;
  readonly caches: readonly CacheMetrics[];
  /** Requests per second over each connection. */
  readonly connections: ReadonlyMap<string, number>;
  readonly monthlyCost: number;
  /** False if the overload feedback loop did not settle; metrics are then the last iterate. */
  readonly converged: boolean;
  readonly iterations: number;
}
