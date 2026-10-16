import type { Client, Flavor } from "@archdrill/model";
import { HOURS_PER_MONTH } from "./capacity";

type Meter = NonNullable<Flavor["capacityUnits"]>;

/** What a load balancer that bills capacity units uses of each dimension, and what it pays. */
export interface CapacityUnitUsage {
  /** Units billed: those of the dimension that needs the most. */
  readonly units: number;
  /** The dimension that sets them. */
  readonly by: "new-connections" | "active-connections" | "processed-bytes";
  readonly newConnectionsPerSec: number;
  readonly activeConnections: number;
  readonly processedGbPerHour: number;
  readonly monthlyCost: number;
}

/** How the problem's clients use connections in one environment. */
export interface ClientConnections extends Pick<Client, "requestsPerConnection" | "connectionSec"> {
  /** Clients holding persistent connections (WebSockets), where the environment says. */
  readonly held: number;
}

/** Requests a second clients send straight to a component, and to every component they reach. */
export interface ClientTraffic {
  readonly fromClients: number;
  readonly allFromClients: number;
  /** Bytes a second the component forwards: requests and responses. */
  readonly bytesPerSec: number;
}

const BYTES_PER_GB = 1e9;
const SECONDS_PER_HOUR = 3600;

/**
 * Capacity units for a load balancer's traffic. Clients open a connection
 * for every `requestsPerConnection` requests they send it, and each stays
 * open for `connectionSec`. Clients that hold persistent connections keep
 * as many open as the environment says, each for `connectionSec`, whatever
 * they send over them, spread over the components they connect to by their
 * share of requests. The requests and responses it forwards are the bytes
 * it processes.
 */
export function capacityUnitUsage(
  meter: Meter,
  traffic: ClientTraffic,
  client: ClientConnections,
): CapacityUnitUsage {
  const share = traffic.allFromClients > 0 ? traffic.fromClients / traffic.allFromClients : 0;
  const held = client.held * share;
  const newConnectionsPerSec =
    held > 0 ? held / client.connectionSec : traffic.fromClients / client.requestsPerConnection;
  const activeConnections = held > 0 ? held : newConnectionsPerSec * client.connectionSec;
  const processedGbPerHour = (traffic.bytesPerSec * SECONDS_PER_HOUR) / BYTES_PER_GB;
  const needs: readonly (readonly [CapacityUnitUsage["by"], number])[] = [
    ["new-connections", newConnectionsPerSec / meter.newConnectionsPerSec],
    ["active-connections", activeConnections / meter.activeConnections],
    ["processed-bytes", processedGbPerHour / meter.processedGbPerHour],
  ];
  const [by, units] = needs.reduce((most, next) => (next[1] > most[1] ? next : most));
  return {
    units,
    by,
    newConnectionsPerSec,
    activeConnections,
    processedGbPerHour,
    monthlyCost: units * meter.pricePerHour * HOURS_PER_MONTH,
  };
}
