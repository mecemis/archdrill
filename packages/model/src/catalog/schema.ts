import { z } from "zod";
import { type Capability, CapabilitySchema } from "./capabilities";

export const IdSchema = z
  .string()
  .regex(/^[a-z0-9][a-zA-Z0-9-]*$/, "ids use letters, digits and dashes, starting lowercase");

/** Physics of one size preset. Numbers are documented ballparks, not quotes. */
export const SizeSchema = z.object({
  label: z.string().min(1),
  capacityPerSec: z
    .object({
      read: z.number().positive(),
      write: z.number().positive(),
    })
    .partial()
    .default({}),
  memoryGb: z.number().positive().optional(),
  latencyMs: z.object({
    base: z.number().nonnegative(),
    cv: z.number().nonnegative(),
  }),
  costPerHour: z.number().nonnegative(),
});
export type Size = z.infer<typeof SizeSchema>;

export const FlavorSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1),
    description: z.string().min(1),
    /** Capabilities added on top of the kind's base capabilities. */
    capabilities: z.array(CapabilitySchema).default([]),
    /** Managed offerings (e.g. multi-AZ load balancers) are redundant without replicas. */
    managedRedundancy: z.boolean().default(false),
    sizes: z.record(IdSchema, SizeSchema).default({}),
    defaultSize: IdSchema.optional(),
    /** Durable storage price per GB-month, in USD, charged per stored copy. */
    storagePricePerGbMonth: z.number().nonnegative().optional(),
    /** Pay-per-request pricing (e.g. on-demand key-value stores), in USD. */
    requestCost: z
      .object({
        readPerMillion: z.number().nonnegative(),
        writePerMillion: z.number().nonnegative(),
      })
      .optional(),
    notes: z.string().optional(),
  })
  .refine((f) => f.defaultSize === undefined || f.defaultSize in f.sizes, {
    message: "defaultSize must name one of the flavor's sizes",
    path: ["defaultSize"],
  })
  .refine((f) => Object.keys(f.sizes).length === 0 || f.defaultSize !== undefined, {
    message: "flavors with sizes need a defaultSize",
    path: ["defaultSize"],
  });
export type Flavor = z.infer<typeof FlavorSchema>;

export const KindSchema = z.object({
  id: IdSchema,
  label: z.string().min(1),
  description: z.string().min(1),
  capabilities: z.array(CapabilitySchema).min(1),
  /** Whether instances can be scaled out with replicas. */
  replicable: z.boolean(),
  /** Whether instances can be bound to problem entities (durable stores). */
  holdsData: z.boolean(),
  /** Whether data can be split across shards (each shard holds part of the keys). */
  shardable: z.boolean().default(false),
  /**
   * Who takes writes: every replica (stateless services) or only each shard's
   * primary (replicated stores, where replicas add read capacity only).
   */
  writeScaling: z.enum(["all-replicas", "primaries"]).default("all-replicas"),
  /**
   * Runs inside the service that calls it (an in-process cache): no network
   * hop, and one independent copy per instance of that service.
   */
  inProcess: z.boolean().default(false),
  flavors: z.array(FlavorSchema).min(1),
});
export type Kind = z.infer<typeof KindSchema>;

export const CatalogSchema = z
  .object({
    version: z.number().int().positive(),
    kinds: z.array(KindSchema).min(1),
  })
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    catalog.kinds.forEach((kind, i) => {
      if (seen.has(kind.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate kind "${kind.id}"`,
          path: ["kinds", i],
        });
      }
      seen.add(kind.id);
      const flavorIds = new Set<string>();
      kind.flavors.forEach((flavor, j) => {
        if (flavorIds.has(flavor.id)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate flavor "${flavor.id}" in kind "${kind.id}"`,
            path: ["kinds", i, "flavors", j],
          });
        }
        flavorIds.add(flavor.id);
      });
    });
  });
export type Catalog = z.infer<typeof CatalogSchema>;

export interface CatalogIndex {
  readonly catalog: Catalog;
  kind(kindId: string): Kind | undefined;
  flavor(kindId: string, flavorId: string): Flavor | undefined;
  /** Base kind capabilities plus flavor extras; empty for unknown kinds. */
  capabilities(kindId: string, flavorId: string): ReadonlySet<Capability>;
}

export function createCatalogIndex(catalog: Catalog): CatalogIndex {
  const kinds = new Map(catalog.kinds.map((k) => [k.id, k]));
  const capabilityCache = new Map<string, ReadonlySet<Capability>>();
  const empty: ReadonlySet<Capability> = new Set();

  const flavor = (kindId: string, flavorId: string) =>
    kinds.get(kindId)?.flavors.find((f) => f.id === flavorId);

  return {
    catalog,
    kind: (kindId) => kinds.get(kindId),
    flavor,
    capabilities(kindId, flavorId) {
      const key = `${kindId}/${flavorId}`;
      const cached = capabilityCache.get(key);
      if (cached) return cached;
      const kind = kinds.get(kindId);
      if (!kind) return empty;
      const extras = flavor(kindId, flavorId)?.capabilities ?? [];
      const result: ReadonlySet<Capability> = new Set([...kind.capabilities, ...extras]);
      capabilityCache.set(key, result);
      return result;
    },
  };
}
