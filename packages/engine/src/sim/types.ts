import type { Environment } from "@archdrill/model";
import type { CapacityUnitUsage } from "./capacity-units";
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
  /** Bytes a second it sends: the values its reads return, or what a proxy forwards. */
  readonly bytesOut: number;
  /** Bytes a second of those it sends clients over the internet: its answers to their requests. */
  readonly bytesToClients: number;
  /**
   * Share of its outbound bandwidth those bytes take, at the shard that holds
   * the hot key; 0 where the catalog gives no bandwidth.
   */
  readonly networkUtilization: number;
  /** Instances it runs in this environment, after autoscaling. */
  readonly instances: number;
  /** Share of arriving requests rejected because the component is overloaded. */
  readonly dropRate: number;
  /** Requests per second that are retries of failed attempts (included in the loads). */
  readonly retryLoad: number;
  /** The environment's faults on this component, for people; empty when healthy. */
  readonly faults: readonly string[];
  /**
   * Its faults fail calls or slow them down, beyond costing it capacity that
   * the rest of its instances may well absorb.
   */
  readonly faultDisrupts: boolean;
  /** Latency added per visit (service + queueing), excluding the network. */
  readonly latency: Moments;
  /** The same at the shard that holds the hot key (equal to `latency` without one). */
  readonly hotLatency: Moments;
  /** Data stored, counting every copy. */
  readonly storageGb: number;
  /** Capacity units it is billed for (a managed load balancer's), or null. */
  readonly capacityUnits: CapacityUnitUsage | null;
  /**
   * Client connections held open on its fullest instance (a shard's primary,
   * for a store its callers pool to), and how many one instance accepts; null
   * where none are held.
   */
  readonly connections: { readonly open: number; readonly limit: number } | null;
  readonly monthlyCost: number;
  readonly costBreakdown: {
    readonly instances: number;
    readonly requests: number;
    readonly capacityUnits: number;
    readonly storage: number;
    /** Data its calls send and receive across zones, both ends' share. */
    readonly crossZone: number;
    /**
     * Its copy in the standby region: instances, stored data, the writes a
     * managed store applies there, and the data replicated to it.
     */
    readonly standbyRegion: number;
    /** The connection proxy in front of it. */
    readonly proxy: number;
    /** I/Os provisioned on its volumes above what they include. */
    readonly iops: number;
    /** What it sends clients over the internet: its share of the Region's tiered bill. */
    readonly internet: number;
  };
  /**
   * For a store that reads pages from a volume: the share of its reads of
   * ordinary keys its page cache answers, the I/Os a second its reads and
   * writes take on one copy, what one copy sustains, and how busy the
   * busiest shard's volumes are. Null for other components.
   */
  readonly disk: {
    readonly hitRatio: number;
    readonly readIops: number;
    readonly writeIops: number;
    readonly limit: number;
    readonly utilization: number;
  } | null;
}

/** How full a caller's pools to a store are (Little's law) and what that does to its calls. */
export interface PoolMetrics {
  readonly connectionId: string;
  /** Connections each caller instance keeps to each copy it calls. */
  readonly poolSize: number;
  /** Copies of the store each caller instance keeps a pool to. */
  readonly copies: number;
  readonly callerInstances: number;
  /** Milliseconds a call holds its connection: the store's latency, the round trip and any proxy. */
  readonly holdMs: number;
  /** Statements in flight per caller instance: its calls a second times `holdMs`. */
  readonly inFlight: number;
  /** In-flight statements over the connections its pools hold; above 1 some calls find none free. */
  readonly utilization: number;
  /** Share of attempts that find no free connection and wait until they give up. */
  readonly exhausted: number;
  /** Milliseconds an attempt that gets a connection waits for it. */
  readonly waitMs: number;
  /** The store's connection proxy holds these pools, not the store. */
  readonly proxied: boolean;
}

/** How the calls over one connection cross zones, and what that costs. */
export interface ConnectionZoneMetrics {
  readonly connectionId: string;
  /** Share of reads, and of writes, that go to an instance in another zone. */
  readonly crossRead: number;
  readonly crossWrite: number;
  /** Mean round trip of a read and of a write over the connection. */
  readonly roundTripMs: { readonly read: number; readonly write: number };
  /** Bytes a second it carries, both ways, for reads and for writes, crossing or not. */
  readonly bytesPerSec: { readonly read: number; readonly write: number };
  /** GB a month that cross zones over it, both directions, at this load. */
  readonly crossGbPerMonth: number;
  /** USD a GB crossing zones costs on this hop, both ends together. */
  readonly usdPerGb: number;
  readonly monthlyCost: number;
  /** What zone-aware routing would save of it; 0 where it is on or cannot help. */
  readonly avoidableMonthlyCost: number;
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
  /** What starts it: client requests, messages from a queue, or a schedule. */
  readonly trigger: "request" | "event" | "schedule";
  /** Requests per second; for a consumer, messages published to it; for a job, items to process. */
  readonly rate: number;
  /**
   * Consumers and jobs that cannot keep up fall behind instead of rejecting
   * work: items per second added to their backlog. Zero for requests.
   */
  readonly backlogGrowth: number;
  /** Deliveries per second of messages that failed before (consumers only). */
  readonly redeliveries: number;
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
  /**
   * Latency of successful requests; failed requests are reported by the
   * success rate instead. For consumers and jobs it is the lag from when the
   * item is ready (published, due) until it is done, waits for batches included.
   */
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
  /** Per connection between components the region holds: what crosses zones. */
  readonly zoneTraffic: ReadonlyMap<string, ConnectionZoneMetrics>;
  /** Per connection to a store that runs one statement per connection: its pools. */
  readonly pools: ReadonlyMap<string, PoolMetrics>;
  readonly monthlyCost: number;
  /** False if the overload feedback loop did not settle; metrics are then the last iterate. */
  readonly converged: boolean;
  readonly iterations: number;
  /** Components a shock (cold caches) tips into lasting overload that retries sustain; empty when none. */
  readonly metastable: readonly MetastableComponent[];
}
