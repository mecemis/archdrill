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

/** Figures on a size, and on a flavor, that need a provenance. */
export const SIZE_NUMBERS = [
  "capacityPerSec",
  "latencyMs",
  "costPerHour",
  "memoryGb",
  "maxConnections",
  "networkGbps",
  "vcpus",
  "ebsIops",
] as const;
export const FLAVOR_NUMBERS = [
  "storagePricePerGbMonth",
  "requestCost",
  "requestUnits",
  "capacityUnits",
  "perKeyCapacityPerSec",
  "startupSec",
  "failoverSec",
  "crossZoneBilling",
  "regionFailoverSec",
  "crossRegionReplication",
  "connectionProxy",
  "pageCache",
  "storageVolume",
  "edgeTtlSec",
] as const;

const ProvenanceMapSchema = z.partialRecord(
  z.enum([...SIZE_NUMBERS, ...FLAVOR_NUMBERS]),
  ProvenanceSchema,
);

/** One tier of a monthly volume price: from this many GB in the month, at this price a GB. */
export const TransferTierSchema = z.strictObject({
  fromGb: z.number().nonnegative(),
  usdPerGb: z.number().nonnegative(),
});
export type TransferTier = z.infer<typeof TransferTierSchema>;

/**
 * What data sent from the Region to clients over the internet costs, in
 * tiers of the month's total: each GB is billed at the tier it falls in.
 */
export const InternetTransferSchema = z
  .strictObject({
    tiers: z.array(TransferTierSchema).min(1),
    provenance: ProvenanceSchema,
  })
  .refine((t) => t.tiers[0]?.fromGb === 0, {
    message: "the first tier starts at 0 GB",
    path: ["tiers"],
  })
  .refine(
    (t) => t.tiers.every((tier, i) => i === 0 || tier.fromGb > (t.tiers[i - 1]?.fromGb ?? 0)),
    {
      message: "tiers climb: each starts above the one before",
      path: ["tiers"],
    },
  );
export type InternetTransfer = z.infer<typeof InternetTransferSchema>;

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
  /**
   * Client connections one instance can hold open: a persistent-connection
   * gateway's clients, or a database's `max_connections`.
   */
  maxConnections: z.number().positive().optional(),
  /**
   * Network bandwidth one instance sustains in each direction, in Gbps: the
   * baseline, since instances burst above it for minutes only. What it
   * sends counts against it: the values its reads return, or for a proxy
   * the requests and responses it forwards.
   */
  networkGbps: z.number().positive().optional(),
  latencyMs: z.object({
    base: z.number().nonnegative(),
    cv: z.number().nonnegative(),
  }),
  costPerHour: z.number().nonnegative(),
  /** vCPUs of one instance, for what is billed by them (a connection proxy). */
  vcpus: z.number().int().positive().optional(),
  /**
   * I/O operations a second one instance sustains to its block storage (its
   * EBS-optimized baseline, in I/Os of up to 16 KiB), however many its
   * volumes are provisioned for. Instances burst above it for minutes only.
   */
  ebsIops: z.number().int().positive().optional(),
  /** The real offering this size stands for, such as "db.m6i.large (AWS RDS)". */
  standsFor: z.string().min(1).optional(),
  provenance: ProvenanceMapSchema.default({}),
});
export type Size = z.infer<typeof SizeSchema>;

export const CrossZoneBillingSchema = z.enum(["each-end", "other-end", "free"]);
export type CrossZoneBilling = z.infer<typeof CrossZoneBillingSchema>;

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
    /**
     * Seconds from losing a primary until a replica has taken over and takes
     * writes again (detection, catch-up and promotion), for stores whose
     * writes go to a primary.
     */
    failoverSec: z.number().positive().optional(),
    /**
     * Who pays for data that crosses zones to or from its instances:
     * `each-end`, it and the instance at the other end each pay for what
     * they send and receive (EC2, RDS); `other-end`, only the other end pays
     * (ElastiCache nodes); `free`, nobody does (a hop through an Application
     * Load Balancer, a regional service). Without it, instances a design
     * runs pay at each end and managed offerings are free.
     */
    crossZoneBilling: CrossZoneBillingSchema.optional(),
    /**
     * Seconds from declaring the primary region lost until the standby
     * region's copy has been promoted and takes writes, for stores whose
     * writes go to a primary. Stores that take writes in every region
     * (DynamoDB global tables) need no promotion.
     */
    regionFailoverSec: z.number().positive().optional(),
    /**
     * A cache that keeps its standby region's copy filled (ElastiCache Global
     * Datastore). Without it, a standby cache starts empty when traffic
     * arrives. Stores always replicate to their standby copy.
     */
    crossRegionReplication: z.boolean().optional(),
    /**
     * A managed proxy a design can put in front of the store (RDS Proxy). It
     * multiplexes its callers' pools: it holds a database connection only
     * while a statement runs on it, so the callers' pools no longer count
     * against `maxConnections`. It adds a hop, and is billed per vCPU of the
     * instances behind it.
     */
    connectionProxy: z
      .strictObject({
        latencyMs: z.number().nonnegative(),
        pricePerVcpuHour: z.number().nonnegative(),
      })
      .optional(),
    /**
     * A store that keeps its data on disk and caches pages of it in memory.
     * A read whose pages are cached costs no I/O; one whose pages are not
     * reads them from the volume.
     */
    pageCache: z
      .strictObject({
        /** Share of an instance's memory that holds cached pages. */
        memoryShare: z.number().positive().max(1),
        /** Bytes of one page. */
        pageBytes: z.number().int().positive(),
        /** Pages a read by key touches (an index's and a row's), each one I/O when not cached. */
        pagesPerRead: z.number().int().positive(),
        /** Pages a write dirties and later writes back: one I/O each, on every copy. */
        pagesPerWrite: z.number().int().positive(),
      })
      .optional(),
    /**
     * The block storage a store with a page cache reads from (RDS gp3): its
     * I/Os a second, which grow with its size and can be provisioned above
     * that, and how long a page read takes.
     */
    storageVolume: z
      .strictObject({
        /** I/Os a second of a small volume, not provisionable. */
        baselineIops: z.number().int().positive(),
        /** Gigabytes from which the volume is striped and gets `stripedIops`. */
        stripedFromGb: z.number().positive(),
        stripedIops: z.number().int().positive(),
        /** The most I/Os a second a striped volume can be provisioned for. */
        maxIops: z.number().int().positive(),
        /** USD per I/O a second provisioned above `stripedIops`, a month. */
        pricePerIopsMonth: z.number().nonnegative(),
        /** Milliseconds one page read takes from an idle volume. */
        readMs: z.number().positive(),
      })
      .optional(),
    /**
     * For a CDN: seconds an object stays at the edge when its origin sets no
     * TTL of its own, before the edge asks the origin again.
     */
    edgeTtlSec: z.number().positive().optional(),
    /**
     * What this offering bills for data it sends clients over the internet,
     * when not the Region's own price (a CDN's edge locations).
     */
    internetTransfer: InternetTransferSchema.optional(),
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
    /**
     * Requests count in units of size (DynamoDB's read and write units, SQS's
     * 64 KB chunks): capacity, request prices and per-key limits are in units.
     * Sizes round up to whole units, and an item that does not exist still
     * takes one.
     */
    requestUnits: z
      .object({
        /**
         * What a unit measures: each item on its own, so a batch costs every
         * item's units (DynamoDB), or a request's whole payload, so a batch of
         * small items is one unit (SQS).
         */
        per: z.enum(["item", "request"]),
        /** Bytes one read unit covers. */
        readBytes: z.number().int().positive(),
        /** Bytes one write unit covers. */
        writeBytes: z.number().int().positive(),
        /** Units a read takes per readBytes: 0.5 for eventually consistent reads. */
        readUnits: z.number().positive().default(1),
      })
      .optional(),
    /**
     * Capacity units a managed load balancer bills on top of its hourly
     * charge (ALB's LCUs). Each hour is billed for the dimension that needs
     * the most units: new connections, open connections, or bytes processed.
     */
    capacityUnits: z
      .object({
        /** USD per unit-hour. */
        pricePerHour: z.number().nonnegative(),
        /** New client connections a second that one unit covers. */
        newConnectionsPerSec: z.number().positive(),
        /** Client connections open at once that one unit covers. */
        activeConnections: z.number().positive(),
        /** GB of requests and responses an hour that one unit covers. */
        processedGbPerHour: z.number().positive(),
      })
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
  /** What its shards are called, where they have a name of their own (an object store's prefixes). */
  shardsLabel: z.string().min(1).optional(),
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
  /**
   * Reads and writes need a majority of a shard's replicas (consensus, or
   * quorum reads and writes): a shard that loses half of them stops.
   */
  quorum: z.boolean().default(false),
  /**
   * Runs one statement at a time on each client connection (PostgreSQL and
   * MySQL serve a connection with a process or a thread of its own). Every
   * caller instance keeps a pool of connections to each copy it calls, and
   * each of them counts against the copy's `maxConnections`.
   */
  pooledConnections: z.boolean().default(false),
  flavors: z.array(FlavorSchema).min(1),
});
export type Kind = z.infer<typeof KindSchema>;

/**
 * Whether a design places a component's instances in zones: it runs its own
 * instances (managed offerings span zones on their own) on the network
 * (in-process components live in their service's instances).
 */
export function placedInZones(kind: Kind, flavor: Flavor): boolean {
  return kind.replicable && !kind.inProcess && !flavor.managedRedundancy;
}

/**
 * Whether a component runs in the design's region, so that losing the
 * region takes it: not a client, nor an external service reached over the
 * internet, nor a CDN's edge locations, nor in-process (it lives in its
 * service's instances).
 */
export function runsInRegion(kind: Kind, flavor: Flavor): boolean {
  const caps = new Set([...kind.capabilities, ...flavor.capabilities]);
  return (
    !kind.inProcess &&
    !caps.has("traffic-source") &&
    !caps.has("external") &&
    !caps.has("edge-cache")
  );
}

/** Who pays for data crossing zones at a flavor's end, defaults included. */
export function crossZoneBillingOf(flavor: Flavor): CrossZoneBilling {
  return flavor.crossZoneBilling ?? (flavor.managedRedundancy ? "free" : "each-end");
}

/**
 * One measured run of a benchmark. Closed runs keep a fixed number of clients
 * busy, each sending its next request when the last one returns; open runs
 * send a fixed rate whatever the replies. A run records what the source
 * measured, and nothing it did not.
 */
export const BenchmarkRunSchema = z.union([
  z
    .strictObject({
      clients: z.number().int().positive(),
      /** Requests a second the clients completed. */
      throughput: z.number().positive().optional(),
      /** Mean latency the clients saw, network included. */
      latencyMs: z.number().positive().optional(),
      /** The engine is known to miss this run, for the reason the calibration gives. */
      beyondModel: z.literal(true).optional(),
    })
    .refine((r) => r.throughput !== undefined || r.latencyMs !== undefined, {
      message: "a run records a throughput, a latency or both",
    }),
  z.strictObject({
    /** Requests a second sent. */
    rate: z.number().positive(),
    /** Median latency the clients saw, network included. */
    p50Ms: z.number().positive(),
    beyondModel: z.literal(true).optional(),
  }),
]);
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;

/**
 * A published benchmark that the engine must reproduce: the catalog size it
 * ran on, how it ran, and what it measured. Calibrations turn the reasoning
 * in a model's text into a test.
 */
export const CalibrationSchema = z.strictObject({
  id: IdSchema,
  title: z.string().min(1),
  /** The benchmark's source (a source of kind "benchmark"). */
  source: IdSchema,
  /** The catalog size the benchmark ran on, with as many replicas as it had. */
  component: z.strictObject({
    kind: IdSchema,
    flavor: IdSchema,
    size: IdSchema,
    replicas: z.number().int().positive().default(1),
  }),
  /** What ran, on what, and how, in a sentence or two. */
  setup: z.string().min(1),
  /**
   * Where the clients ran: in the servers' zone, or elsewhere in the region
   * (another zone or network), as a design's calls do.
   */
  network: z.enum(["zone", "region"]),
  /** Share of requests that read; the rest write. */
  reads: z.number().min(0).max(1),
  /**
   * How many benchmark requests one catalog request stands for, when the
   * benchmark's requests are lighter than the ones the catalog models. The
   * replay gives the size that many times its throughput and a matching
   * fraction of its service time.
   */
  work: z.strictObject({ ratio: z.number().positive(), why: z.string().min(1) }).optional(),
  /** Why the engine misses the runs marked beyondModel. */
  beyondModel: z.string().min(1).optional(),
  runs: z.array(BenchmarkRunSchema).min(1),
});
export type Calibration = z.infer<typeof CalibrationSchema>;

type CatalogInput = {
  readonly kinds: readonly Kind[];
  readonly sources: readonly Source[];
};

/** What makes a calibration impossible to replay as the benchmark ran. */
function calibrationIssues(catalog: CatalogInput, calibration: Calibration): string[] {
  const issues: string[] = [];
  const named = `calibration "${calibration.id}"`;
  const source = catalog.sources.find((s) => s.id === calibration.source);
  if (source?.kind !== "benchmark") issues.push(`${named} must cite a benchmark source`);
  const { kind: kindId, flavor: flavorId, size: sizeId, replicas } = calibration.component;
  const kind = catalog.kinds.find((k) => k.id === kindId);
  const flavor = kind?.flavors.find((f) => f.id === flavorId);
  const size = flavor?.sizes[sizeId];
  if (!kind || !flavor || !size) {
    issues.push(`${named} names unknown size ${kindId}/${flavorId}/${sizeId}`);
  } else {
    if (replicas > 1 && (!kind.replicable || flavor.managedRedundancy)) {
      issues.push(`${named} gives replicas to ${kindId}/${flavorId}, which has none of its own`);
    }
    if (calibration.reads > 0 && size.capacityPerSec.read === undefined) {
      issues.push(`${named} reads from a size that takes no reads`);
    }
    if (calibration.reads < 1 && size.capacityPerSec.write === undefined) {
      issues.push(`${named} writes to a size that takes no writes`);
    }
  }
  const loads = calibration.runs.map((r) => ("rate" in r ? `rate ${r.rate}` : `${r.clients}`));
  if (new Set(loads).size !== loads.length) {
    issues.push(`${named} lists the same load twice`);
  }
  if (calibration.runs.some((r) => r.beyondModel) !== (calibration.beyondModel !== undefined)) {
    issues.push(`${named} explains beyondModel exactly when a run is marked so`);
  }
  return issues;
}

export const CatalogSchema = z
  .object({
    version: z.number().int().positive(),
    kinds: z.array(KindSchema).min(1),
    /** Everything the catalog's numbers cite. */
    sources: z.array(SourceSchema).default([]),
    /** Benchmarks the engine reproduces with the catalog's numbers. */
    calibrations: z.array(CalibrationSchema).default([]),
    /** What data sent to clients over the internet costs; free when absent. */
    internetTransfer: InternetTransferSchema.optional(),
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
        if (flavor.internetTransfer) {
          cited({ tiers: flavor.internetTransfer.provenance }, [
            "kinds",
            i,
            "flavors",
            j,
            "internetTransfer",
          ]);
        }
        for (const [sizeId, size] of Object.entries(flavor.sizes)) {
          cited(size.provenance, ["kinds", i, "flavors", j, "sizes", sizeId]);
        }
      });
    });
    if (catalog.internetTransfer) {
      cited({ tiers: catalog.internetTransfer.provenance }, ["internetTransfer"]);
    }
    const calibrationIds = new Set<string>();
    catalog.calibrations.forEach((calibration, i) => {
      if (calibrationIds.has(calibration.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate calibration "${calibration.id}"`,
          path: ["calibrations", i, "id"],
        });
      }
      calibrationIds.add(calibration.id);
      for (const message of calibrationIssues(catalog, calibration)) {
        ctx.addIssue({ code: "custom", message, path: ["calibrations", i] });
      }
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
