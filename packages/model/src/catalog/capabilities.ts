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
] as const;

export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

/** Capabilities that let a component sit between a client and a handler on an ingress route. */
export const INGRESS_CAPABILITIES: ReadonlySet<Capability> = new Set([
  "load-balancing",
  "routing",
  "edge-cache",
]);
