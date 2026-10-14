import { z } from "zod";
import { type Capability, CapabilitySchema } from "./capabilities";

export const IdSchema = z
  .string()
  .regex(/^[a-z0-9][a-zA-Z0-9-]*$/, "ids use letters, digits and dashes, starting lowercase");

/**
 * Where a number came from. Every catalog number is either PUBLISHED (a
 * price, quota or spec a vendor states, cited) or a MODEL (how this catalog
 * turns specs and measurements into simulator behaviour, with its reasoning
 * and the sources it rests on). The two are kept apart on purpose: a model
 * presented as a measurement is the error this guards against.
 */
export const SourceSchema = z.strictObject({
  id: IdSchema,
  title: z.string().min(1),
  url: z.url(),
  publisher: z.string().min(1),
  /** A price list, a quota or limit, a published spec, a measurement, or documentation. */
  kind: z.enum(["price", "quota", "spec", "benchmark", "documentation"]),
  /** When the figure was read (YYYY-MM-DD). Prices and quotas change; a stale date should show. */
  retrieved: z.iso.date(),
  /** Who read it, when it was not read first-hand: another project's cited data, for example. */
  via: z.string().min(1).optional(),
});
export type Source = z.infer<typeof SourceSchema>;

export const ProvenanceSchema = z.union([
  z.strictObject({
    /** The source that states this number. */
    published: IdSchema,
    note: z.string().min(1).optional(),
  }),
  z.strictObject({
    /** How the number is modelled, in a sentence or two a reader can check. */
    model: z.string().min(1),
    /** Sources the model rests on; empty for a stated assumption. */
    basis: z.array(IdSchema).default([]),
  }),
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Numbers on a size, and on a flavor, that need a provenance. */
export const SIZE_NUMBERS = [
  "capacityPerSec",
  "latencyMs",
  "costPerHour",
  "memoryGb",
  "maxConnections",
] as const;
export const FLAVOR_NUMBERS = [
  "storagePricePerGbMonth",
  "requestCost",
  "perKeyCapacityPerSec",
  "startupSec",
] as const;

const ProvenanceMapSchema = z.partialRecord(
  z.enum([...SIZE_NUMBERS, ...FLAVOR_NUMBERS]),
  ProvenanceSchema,
);

/** Physics of one size preset. Every number cites where it came from (see SourceSchema). */
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
  /** Open client connections one instance can hold (persistent-connection gateways). */
  maxConnections: z.number().positive().optional(),
  latencyMs: z.object({
    base: z.number().nonnegative(),
    cv: z.number().nonnegative(),
  }),
  costPerHour: z.number().nonnegative(),
  /** The real offering this size stands for, such as "db.m6i.large (AWS RDS)". */
  standsFor: z.string().min(1).optional(),
  provenance: ProvenanceMapSchema.default({}),
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
    /**
     * Seconds a new instance takes to start taking traffic once an autoscaler
     * asks for it (boot, warm-up, health checks).
     */
    startupSec: z.number().nonnegative().optional(),
    sizes: z.record(IdSchema, SizeSchema).default({}),
    defaultSize: IdSchema.optional(),
    /** Durable storage price per GB-month, in USD, charged per stored copy. */
    storagePricePerGbMonth: z.number().nonnegative().optional(),
    /**
     * What a single key can take, whatever the provisioned capacity: one key
     * lives in one partition (for example DynamoDB's 1,000 writes a second).
     */
    perKeyCapacityPerSec: z
      .object({ read: z.number().positive(), write: z.number().positive() })
      .partial()
      .optional(),
    /** Pay-per-request pricing (e.g. on-demand key-value stores), in USD. */
    requestCost: z
      .object({
        readPerMillion: z.number().nonnegative(),
        writePerMillion: z.number().nonnegative(),
      })
      .optional(),
    notes: z.string().optional(),
    /** The real offering the flavor stands for, where its sizes do not say. */
    standsFor: z.string().min(1).optional(),
    /** Provenance of the flavor's numbers, and defaults for every size's. */
    provenance: ProvenanceMapSchema.default({}),
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
    /** Everything the catalog's numbers cite. */
    sources: z.array(SourceSchema).default([]),
  })
  .superRefine((catalog, ctx) => {
    const sourceIds = new Set(catalog.sources.map((s) => s.id));
    const cited = (provenance: Partial<Record<string, Provenance>>, path: (string | number)[]) => {
      for (const [field, entry] of Object.entries(provenance)) {
        const ids = !entry ? [] : "published" in entry ? [entry.published] : entry.basis;
        for (const id of ids) {
          if (!sourceIds.has(id)) {
            ctx.addIssue({
              code: "custom",
              message: `${field} cites unknown source "${id}"`,
              path: [...path, "provenance", field],
            });
          }
        }
      }
    };
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
        cited(flavor.provenance, ["kinds", i, "flavors", j]);
        for (const [sizeId, size] of Object.entries(flavor.sizes)) {
          cited(size.provenance, ["kinds", i, "flavors", j, "sizes", sizeId]);
        }
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
