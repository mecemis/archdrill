import { z } from "zod";

/**
 * Capabilities are the vocabulary evaluation reasons with. Checks and actions
 * refer to capabilities, never to products, so any flavor that provides a
 * capability satisfies the same checks.
 */
export const CAPABILITIES = [
  "traffic-source",
  "load-balancing",
  "health-checking",
  "routing",
  "edge-cache",
  "stateless-compute",
  "volatile-kv",
  "ttl",
  "durable-store",
  "unique-constraint",
  "conditional-write",
  "transactions",
  "secondary-index",
  "range-scan",
  "atomic-increment",
  "id-generation",
  "leases",
  "consensus",
  "rate-limiting",
  "authn",
  "async-buffer",
  "stream-processing",
  "persistent-connections",
  "push-notifications",
  "payments",
  "external",
  "threat-lists",
  /** Takes whole objects from clients and hands them back itself, with no service in between. */
  "serves-objects",
] as const;

export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

/** What starts an operation: a client's request, a message from a queue, or a schedule. */
export type TriggerType = "request" | "event" | "schedule";

/**
 * Whether a component can run an operation's flow: services run any; stream
 * processors only take messages from a queue; object storage only answers
 * clients' requests, by serving or storing the object itself.
 */
export function canHandle(capabilities: ReadonlySet<Capability>, trigger: TriggerType): boolean {
  return (
    capabilities.has("stateless-compute") ||
    (trigger === "event" && capabilities.has("stream-processing")) ||
    (trigger === "request" && capabilities.has("serves-objects"))
  );
}

/**
 * A handler that only serves objects (object storage): it answers with the
 * object, or stores it, and can neither call anything nor decide anything.
 */
export function onlyServesObjects(capabilities: ReadonlySet<Capability>): boolean {
  return capabilities.has("serves-objects") && !capabilities.has("stateless-compute");
}

/** Capabilities that let a component sit between a client and a handler on an ingress route. */
export const INGRESS_CAPABILITIES: ReadonlySet<Capability> = new Set([
  "load-balancing",
  "routing",
  "edge-cache",
]);
