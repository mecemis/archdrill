import type { BenchmarkRun, Calibration, CatalogIndex } from "@archdrill/model";
import { NETWORK_RTT_MS } from "./calls";
import { type ComponentProfile, componentProfile } from "./capacity";
import { addMoments, componentLatency, type Load, networkHop, summarize } from "./summary";

/**
 * Replays published benchmarks with the engine's own component model, so the
 * catalog's capacities and latencies are checked against measurements rather
 * than only explained.
 */

/**
 * Round trip between hosts in one zone, where benchmarks run their clients.
 * AWS puts it below a millisecond with enhanced networking; ElastiCache's
 * median of 0.44 ms, service included, bounds it from above. Designs pay
 * NETWORK_RTT_MS per hop instead, since their calls cross zones.
 */
export const SAME_ZONE_RTT_MS = 0.1;

/** How far a replayed run may land from the measured one, relative to it. */
export const CALIBRATION_TOLERANCE = 0.15;

/** Bisection steps for a closed run's throughput; far more precision than any benchmark has. */
const BISECTION_STEPS = 100;

export interface ReplayedRun {
  readonly run: BenchmarkRun;
  /** What the engine gives for each measurement the run records. */
  readonly engine: {
    readonly throughput?: number;
    readonly latencyMs?: number;
    readonly p50Ms?: number;
  };
  /** Largest relative difference over the run's measurements. */
  readonly error: number;
  readonly within: boolean;
}

/**
 * The calibrated size as the benchmark ran it. Lighter requests than the
 * catalog's (`work`) mean that many more a second, each served in that
 * fraction of the time, with as many in service at once.
 */
export function benchmarkedProfile(
  calibration: Calibration,
  catalog: CatalogIndex,
): ComponentProfile {
  const { kind, flavor, size, replicas } = calibration.component;
  const profile = componentProfile(
    {
      id: calibration.id,
      kind,
      flavor,
      size,
      label: calibration.title,
      replicas,
      shards: 1,
      zones: 1,
      data: [],
    },
    catalog,
  );
  if (!profile) throw new Error(`calibration "${calibration.id}" names a component without a size`);
  // Servers come from read capacity, as they do for a design, even for a write-only run.
  const work = calibration.work?.ratio ?? 1;
  return {
    ...profile,
    readCapacity: profile.readCapacity * work,
    writeCapacity: profile.writeCapacity * work,
    serviceTimeMs: profile.serviceTimeMs / work,
  };
}

export function roundTripFor(network: Calibration["network"]): number {
  return network === "zone" ? SAME_ZONE_RTT_MS : NETWORK_RTT_MS;
}

const loadAt = (rate: number, reads: number): Load => ({
  read: rate * reads,
  write: rate * (1 - reads),
});

/**
 * Clients that each send their next request when the last one returns:
 * throughput X settles where X = clients / (latency at X + round trip),
 * Little's law over the engine's queueing latency.
 */
export function closedLoop(
  profile: ComponentProfile,
  reads: number,
  roundTripMs: number,
  clients: number,
): { readonly throughput: number; readonly latencyMs: number } {
  const latencyAt = (rate: number) =>
    componentLatency(loadAt(rate, reads), profile).mean + roundTripMs;
  const sent = (rate: number) => (clients * 1000) / latencyAt(rate);
  // Without queueing the clients send the most; the answer lies below.
  let low = 0;
  let high = sent(0);
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (low + high) / 2;
    if (sent(mid) > mid) low = mid;
    else high = mid;
  }
  const throughput = (low + high) / 2;
  return { throughput, latencyMs: (clients * 1000) / throughput };
}

/** Requests sent at a fixed rate: the latency the clients see, network included. */
export function openLoop(
  profile: ComponentProfile,
  reads: number,
  roundTripMs: number,
  rate: number,
) {
  const latency = addMoments(
    componentLatency(loadAt(rate, reads), profile),
    networkHop(roundTripMs),
  );
  return summarize([{ ...latency, weight: 1 }]);
}

const relativeError = (engine: number, measured: number) => Math.abs(engine / measured - 1);

/** Every run of a calibration, replayed, with how far the engine lands from it. */
export function replayCalibration(
  calibration: Calibration,
  catalog: CatalogIndex,
): readonly ReplayedRun[] {
  const profile = benchmarkedProfile(calibration, catalog);
  const roundTrip = roundTripFor(calibration.network);
  return calibration.runs.map((run) => {
    if ("rate" in run) {
      const p50Ms = openLoop(profile, calibration.reads, roundTrip, run.rate).p50;
      const error = relativeError(p50Ms, run.p50Ms);
      return { run, engine: { p50Ms }, error, within: error <= CALIBRATION_TOLERANCE };
    }
    const replayed = closedLoop(profile, calibration.reads, roundTrip, run.clients);
    const errors: number[] = [];
    if (run.throughput !== undefined)
      errors.push(relativeError(replayed.throughput, run.throughput));
    if (run.latencyMs !== undefined) errors.push(relativeError(replayed.latencyMs, run.latencyMs));
    const error = Math.max(...errors);
    return {
      run,
      engine: {
        ...(run.throughput !== undefined && { throughput: replayed.throughput }),
        ...(run.latencyMs !== undefined && { latencyMs: replayed.latencyMs }),
      },
      error,
      within: error <= CALIBRATION_TOLERANCE,
    };
  });
}
