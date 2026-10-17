import { type Attempt, AttemptSchema } from "../attempt/schema";
import { type Catalog, CatalogSchema, createCatalogIndex } from "../catalog/schema";
import { type Problem, ProblemSchema } from "../problem/schema";

const size = (read: number, write: number, base: number, cost: number) => ({
  label: "medium",
  capacityPerSec: { read, write },
  latencyMs: { base, cv: 0.5 },
  costPerHour: cost,
});

/** A small, self-contained catalog for unit tests. Content tests use the real one. */
export const testCatalog: Catalog = CatalogSchema.parse({
  version: 1,
  kinds: [
    {
      id: "client",
      label: "Client",
      description: "Origin of user traffic.",
      capabilities: ["traffic-source"],
      replicable: false,
      holdsData: false,
      flavors: [{ id: "browser", label: "Browser", description: "Web browser." }],
    },
    {
      id: "load-balancer",
      label: "Load balancer",
      description: "Spreads traffic across replicas.",
      capabilities: ["load-balancing", "health-checking"],
      replicable: false,
      holdsData: false,
      flavors: [
        { id: "alb", label: "ALB", description: "Managed L7 LB.", managedRedundancy: true },
      ],
    },
    {
      id: "service",
      label: "Service",
      description: "Stateless application service.",
      capabilities: ["stateless-compute"],
      replicable: true,
      holdsData: false,
      flavors: [
        {
          id: "generic",
          label: "Service",
          description: "Stateless service.",
          sizes: { m: size(3000, 3000, 2, 0.17) },
          defaultSize: "m",
        },
      ],
    },
    {
      id: "cache",
      label: "Cache",
      description: "In-memory key-value cache.",
      capabilities: ["volatile-kv", "ttl"],
      replicable: true,
      holdsData: false,
      shardable: true,
      writeScaling: "primaries",
      flavors: [
        {
          id: "redis",
          label: "Redis",
          description: "Redis.",
          capabilities: ["atomic-increment"],
          sizes: { m: { ...size(150000, 120000, 0.5, 0.32), memoryGb: 26 } },
          defaultSize: "m",
        },
      ],
    },
    {
      id: "relational-db",
      label: "Relational database",
      description: "SQL database.",
      capabilities: ["durable-store", "unique-constraint", "conditional-write", "transactions"],
      replicable: true,
      holdsData: true,
      shardable: true,
      writeScaling: "primaries",
      flavors: [
        {
          id: "postgres",
          label: "PostgreSQL",
          description: "Postgres.",
          sizes: { m: size(20000, 5000, 2, 1.4) },
          defaultSize: "m",
        },
      ],
    },
    {
      id: "near-cache",
      label: "Near cache",
      description: "In-process cache inside a service.",
      capabilities: ["volatile-kv", "ttl"],
      replicable: false,
      holdsData: false,
      inProcess: true,
      flavors: [
        {
          id: "lru",
          label: "In-process LRU",
          description: "LRU map in the service's memory.",
          sizes: {
            m: {
              label: "1 GB",
              capacityPerSec: {},
              latencyMs: { base: 0.02, cv: 0.5 },
              costPerHour: 0,
              memoryGb: 1,
            },
          },
          defaultSize: "m",
        },
      ],
    },
    {
      id: "api-gateway",
      label: "API gateway",
      description: "Routes, authenticates and rate-limits requests.",
      capabilities: ["routing", "rate-limiting", "authn"],
      replicable: false,
      holdsData: false,
      flavors: [
        {
          id: "managed",
          label: "Managed gateway",
          description: "Managed gateway.",
          managedRedundancy: true,
        },
      ],
    },
    {
      id: "id-generator",
      label: "Id generator",
      description: "Hands out unique keys.",
      capabilities: ["id-generation"],
      replicable: true,
      holdsData: false,
      flavors: [
        {
          id: "kgs",
          label: "KGS",
          description: "Key generation service.",
          sizes: { m: size(50000, 50000, 1, 0.17) },
          defaultSize: "m",
        },
      ],
    },
    {
      id: "key-value-db",
      label: "Key-value database",
      description: "Managed key-value store.",
      capabilities: ["durable-store", "conditional-write", "ttl", "atomic-increment"],
      replicable: false,
      holdsData: true,
      flavors: [
        {
          id: "dynamodb",
          label: "DynamoDB",
          description: "DynamoDB.",
          managedRedundancy: true,
          perKeyCapacityPerSec: { write: 1000 },
          requestCost: { readPerMillion: 0.125, writePerMillion: 0.625 },
          sizes: { "on-demand": size(1_000_000, 1_000_000, 4, 0) },
          defaultSize: "on-demand",
        },
      ],
    },
    {
      id: "wide-column-db",
      label: "Wide-column database",
      description: "Partitioned store for heavy writes.",
      capabilities: ["durable-store", "atomic-increment", "ttl"],
      replicable: true,
      holdsData: true,
      shardable: true,
      writeScaling: "primaries",
      flavors: [
        {
          id: "cassandra",
          label: "Cassandra",
          description: "Cassandra.",
          sizes: { m: size(15000, 30000, 2, 0.6) },
          defaultSize: "m",
        },
      ],
    },
    {
      id: "queue",
      label: "Message queue",
      description: "Holds messages for consumers.",
      capabilities: ["async-buffer"],
      replicable: true,
      holdsData: false,
      flavors: [
        {
          id: "managed-queue",
          label: "Managed queue",
          description: "Managed queue.",
          managedRedundancy: true,
          sizes: { m: size(100000, 100000, 5, 0) },
          defaultSize: "m",
        },
      ],
    },
    {
      id: "websocket-gateway",
      label: "WebSocket gateway",
      description: "Holds persistent connections.",
      capabilities: ["routing", "persistent-connections"],
      replicable: true,
      holdsData: false,
      flavors: [
        {
          id: "connection-servers",
          label: "Connection servers",
          description: "Connection servers.",
          sizes: { m: { ...size(100000, 100000, 1, 0.4), maxConnections: 1000 } },
          defaultSize: "m",
        },
      ],
    },
    {
      id: "external-api",
      label: "External API",
      description: "A third-party service.",
      capabilities: ["external"],
      replicable: false,
      holdsData: false,
      flavors: [
        {
          id: "url-safety",
          label: "URL-safety API",
          description: "Flags malicious URLs.",
          managedRedundancy: true,
          sizes: {
            quota: {
              label: "quota",
              capacityPerSec: { read: 2000 },
              latencyMs: { base: 50, cv: 0.5 },
              costPerHour: 0,
            },
          },
          defaultSize: "quota",
        },
        {
          id: "url-safety-list",
          label: "URL-safety API (local lists)",
          description: "Provides threat lists to match locally and confirms matches.",
          capabilities: ["threat-lists"],
          managedRedundancy: true,
          sizes: {
            quota: {
              label: "quota",
              capacityPerSec: { read: 100 },
              latencyMs: { base: 50, cv: 0.5 },
              costPerHour: 0,
            },
          },
          defaultSize: "quota",
        },
      ],
    },
  ],
});

export const testCatalogIndex = createCatalogIndex(testCatalog);

/**
 * The test catalog with Postgres as RDS runs it: one statement per
 * connection, 25 connections an instance (low enough to reach), 8 vCPUs and
 * a connection proxy.
 */
export const pooledCatalogIndex = createCatalogIndex({
  ...testCatalog,
  kinds: testCatalog.kinds.map((kind) =>
    kind.id === "relational-db"
      ? {
          ...kind,
          pooledConnections: true,
          flavors: kind.flavors.map((f) => ({
            ...f,
            connectionProxy: { latencyMs: 2, pricePerVcpuHour: 0.015 },
            sizes: Object.fromEntries(
              Object.entries(f.sizes).map(([id, s]) => [
                id,
                { ...s, maxConnections: 25, vcpus: 8 },
              ]),
            ),
          })),
        }
      : kind,
  ),
});

export const testProblem: Problem = ProblemSchema.parse({
  id: "url-shortener",
  version: 1,
  title: "URL Shortener",
  levels: ["senior"],
  brief: "Shorten URLs and redirect visitors.",
  requirements: [
    { id: "FR-1", kind: "functional", text: "Create short links." },
    { id: "FR-2", kind: "functional", text: "Redirect to the long URL." },
    { id: "FR-3", kind: "functional", text: "Expired links stop redirecting." },
  ],
  entities: [
    { name: "Link", key: "code", fields: ["code", "longUrl", "expiresAt"], avgBytes: 500 },
    { name: "LinkStats", key: "code", fields: ["code", "clicks"], avgBytes: 64 },
    { name: "Click", key: "clickId", fields: ["clickId", "code", "at"], avgBytes: 100 },
  ],
  operations: [
    {
      id: "redirect",
      label: "Redirect",
      method: "GET",
      path: "/{code}",
      bytes: { request: 600, response: 300 },
      class: "read",
      idempotent: true,
      successStatuses: [301, 302, 404, 410],
      requirements: ["FR-2", "FR-3"],
    },
    {
      id: "create-link",
      label: "Create link",
      method: "POST",
      path: "/links",
      bytes: { request: 800, response: 400 },
      class: "write",
      idempotent: false,
      successStatuses: [201, 400, 409],
      requirements: ["FR-1"],
    },
    {
      id: "disable-link",
      label: "Disable link",
      method: "POST",
      path: "/links/{code}/disable",
      bytes: { request: 600, response: 200 },
      class: "write",
      idempotent: true,
      successStatuses: [200, 204, 404],
      requirements: ["FR-3"],
    },
    {
      id: "scan-link",
      label: "Scan new link",
      trigger: { type: "event", event: "link-created" },
      class: "write",
      idempotent: true,
      successStatuses: [200],
      requirements: ["FR-1"],
    },
    {
      id: "record-click",
      label: "Record click",
      trigger: { type: "event", event: "link-clicked" },
      class: "write",
      idempotent: false,
      successStatuses: [200],
      requirements: ["FR-2"],
    },
    {
      id: "purge-expired",
      label: "Purge expired links",
      trigger: { type: "schedule", description: "Deletes expired links." },
      class: "write",
      idempotent: true,
      successStatuses: [200],
      requirements: ["FR-3"],
    },
  ],
  events: [
    { id: "link-created", label: "Link created", entity: "Link" },
    { id: "link-clicked", label: "Link clicked", entity: "Link" },
  ],
  decisionPoints: [
    {
      id: "redirect-status",
      question: "Which redirect status?",
      options: [
        { id: "s301", label: "301" },
        { id: "s302", label: "302" },
      ],
    },
    {
      id: "code-length",
      question: "How long are generated codes?",
      options: [
        { id: "6", label: "6 characters" },
        { id: "7", label: "7 characters" },
        { id: "8", label: "8 characters" },
      ],
      default: "7",
    },
    {
      id: "expired-status",
      question: "What does an expired link return?",
      options: [
        { id: "404", label: "404 Not Found" },
        { id: "410", label: "410 Gone" },
      ],
    },
    {
      id: "code-reuse",
      question: "Can an expired code be reused?",
      options: [
        { id: "never", label: "Never" },
        { id: "after-grace", label: "After a grace period" },
      ],
    },
    {
      id: "replication-mode",
      question: "How does the link store replicate writes?",
      options: [
        { id: "async", label: "Asynchronous" },
        { id: "semi-sync", label: "Semi-synchronous" },
        { id: "sync", label: "Synchronous" },
      ],
    },
  ],
  scenarios: ["s2-redirect"],
});

/**
 * Client → ALB → link-api (3 replicas) → Redis cache-aside → Postgres.
 * The redirect flow handles every outcome and populates the cache on a miss.
 */
export function cacheAsideAttempt(): Attempt {
  return AttemptSchema.parse({
    schemaVersion: 1,
    problemId: "url-shortener",
    problemVersion: 1,
    architecture: {
      components: [
        { id: "client", kind: "client", flavor: "browser", label: "Visitors" },
        { id: "lb", kind: "load-balancer", flavor: "alb", label: "ALB" },
        {
          id: "api",
          kind: "service",
          flavor: "generic",
          label: "Link API",
          size: "m",
          replicas: 3,
        },
        { id: "redis", kind: "cache", flavor: "redis", label: "Redis", size: "m", replicas: 2 },
        {
          id: "db",
          kind: "relational-db",
          flavor: "postgres",
          label: "Postgres",
          size: "m",
          replicas: 2,
          data: [{ entity: "Link" }],
        },
      ],
      connections: [
        { id: "client--lb", from: "client", to: "lb" },
        { id: "lb--api", from: "lb", to: "api" },
        { id: "api--redis", from: "api", to: "redis" },
        { id: "api--db", from: "api", to: "db" },
      ],
    },
    flows: [
      {
        operation: "redirect",
        handler: "api",
        root: "get",
        steps: {
          get: {
            type: "call",
            target: "redis",
            action: "cache.get",
            entity: "Link",
            next: { hit: "expiryHit", miss: "read", error: "read" },
          },
          expiryHit: {
            type: "logic",
            logic: "checkExpiry",
            next: { valid: "r302", expired: "r410" },
          },
          read: {
            type: "call",
            target: "db",
            action: "store.read",
            entity: "Link",
            next: { found: "expiryDb", notFound: "r404", error: "r503" },
          },
          expiryDb: {
            type: "logic",
            logic: "checkExpiry",
            next: { valid: "populate", expired: "r410" },
          },
          populate: {
            type: "call",
            target: "redis",
            action: "cache.set",
            entity: "Link",
            ttlSec: 3600,
            next: { ok: "r302", error: "r302" },
          },
          r302: { type: "respond", status: 302 },
          r404: { type: "respond", status: 404 },
          r410: { type: "respond", status: 410 },
          r503: { type: "respond", status: 503 },
        },
      },
    ],
    layout: {
      client: { x: 0, y: 0 },
      lb: { x: 200, y: 0 },
      api: { x: 400, y: 0 },
      redis: { x: 600, y: -100 },
      db: { x: 600, y: 100 },
    },
  });
}
