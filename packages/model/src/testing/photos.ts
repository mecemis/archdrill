import { type Attempt, AttemptSchema } from "../attempt/schema";
import { createCatalogIndex } from "../catalog/schema";
import { type Problem, ProblemSchema } from "../problem/schema";
import { testCatalog } from "./fixtures";

/**
 * The test catalog with object storage (S3's numbers: 5,500 reads and 3,500
 * writes a second per prefix, billed per request), and services whose
 * network carries what they send (c6i.xlarge's 1.562 Gbps baseline).
 */
export const photosCatalogIndex = createCatalogIndex({
  ...testCatalog,
  kinds: [
    ...testCatalog.kinds.map((kind) =>
      kind.id === "service"
        ? {
            ...kind,
            flavors: kind.flavors.map((f) => ({
              ...f,
              sizes: Object.fromEntries(
                Object.entries(f.sizes).map(([id, s]) => [id, { ...s, networkGbps: 1.562 }]),
              ),
            })),
          }
        : kind,
    ),
    {
      id: "object-store",
      label: "Object storage",
      description: "Stores whole objects and serves them to clients.",
      capabilities: ["durable-store", "serves-objects"],
      replicable: false,
      holdsData: true,
      shardable: true,
      writeScaling: "all-replicas",
      inProcess: false,
      quorum: false,
      pooledConnections: false,
      flavors: [
        {
          id: "s3",
          label: "S3",
          description: "S3 Standard.",
          capabilities: [],
          managedRedundancy: true,
          crossZoneBilling: "free",
          storagePricePerGbMonth: 0.023,
          requestCost: { readPerMillion: 0.4, writePerMillion: 5 },
          sizes: {
            prefix: {
              label: "per prefix",
              capacityPerSec: { read: 5500, write: 3500 },
              latencyMs: { base: 120, cv: 0.35 },
              costPerHour: 0,
              provenance: {},
            },
          },
          defaultSize: "prefix",
          provenance: {},
        },
      ],
    },
  ],
});

/** Photos that clients upload and read: 200 KB each. */
export const photosProblem: Problem = ProblemSchema.parse({
  id: "photos",
  version: 1,
  title: "Photos",
  levels: ["senior"],
  brief: "People share photos.",
  requirements: [{ id: "FR-1", kind: "functional", text: "Share photos." }],
  entities: [{ name: "Photo", key: "photoId", fields: ["photoId", "bytes"], avgBytes: 200000 }],
  operations: [
    {
      id: "start-upload",
      label: "Start upload",
      method: "POST",
      path: "/uploads",
      bytes: { request: 400, response: 1200 },
      class: "read",
      idempotent: true,
      successStatuses: [200],
    },
    {
      id: "upload-photo",
      label: "Upload photo",
      method: "PUT",
      path: "/photos/{id}",
      bytes: { request: 200400, response: 300 },
      class: "write",
      idempotent: true,
      successStatuses: [200],
    },
    {
      id: "read-photo",
      label: "Read photo",
      method: "GET",
      path: "/photos/{id}",
      bytes: { request: 500, response: 200300 },
      class: "read",
      idempotent: true,
      successStatuses: [200],
    },
  ],
  logic: ["signUpload"],
  scenarios: ["s1"],
});

/**
 * Where the photos' bytes go: straight between clients and object storage,
 * with the service only signing uploads, or through the service.
 */
export type PhotoRoute = "direct" | "through-service";

/**
 * Users → ALB → API (2 instances), and photos in S3 over 4 prefixes. The API
 * signs uploads. Directly, clients put and get photos in S3 themselves;
 * through the service, the API stores and reads every photo for them.
 */
export function photosAttempt(route: PhotoRoute = "direct"): Attempt {
  const direct = route === "direct";
  const served = (operation: string) => ({
    operation,
    handler: "photos",
    root: "done",
    steps: { done: { type: "respond", status: 200 } },
  });
  return AttemptSchema.parse({
    schemaVersion: 1,
    problemId: "photos",
    problemVersion: 1,
    architecture: {
      components: [
        { id: "users", kind: "client", flavor: "browser", label: "Users" },
        { id: "lb", kind: "load-balancer", flavor: "alb", label: "ALB" },
        { id: "api", kind: "service", flavor: "generic", label: "API", size: "m", replicas: 2 },
        {
          id: "photos",
          kind: "object-store",
          flavor: "s3",
          label: "Photos",
          shards: 4,
          data: [{ entity: "Photo" }],
        },
      ],
      connections: [
        { id: "users--lb", from: "users", to: "lb" },
        { id: "lb--api", from: "lb", to: "api" },
        { id: "api--photos", from: "api", to: "photos" },
        ...(direct ? [{ id: "users--photos", from: "users", to: "photos" }] : []),
      ],
    },
    flows: [
      {
        operation: "start-upload",
        handler: "api",
        root: "sign",
        steps: {
          sign: { type: "logic", logic: "signUpload", next: { ok: "ok" } },
          ok: { type: "respond", status: 200 },
        },
      },
      direct
        ? served("upload-photo")
        : {
            operation: "upload-photo",
            handler: "api",
            root: "put",
            steps: {
              put: {
                type: "call",
                target: "photos",
                action: "store.insert",
                entity: "Photo",
                next: { ok: "ok", error: "unavailable" },
              },
              ok: { type: "respond", status: 200 },
              unavailable: { type: "respond", status: 503 },
            },
          },
      direct
        ? served("read-photo")
        : {
            operation: "read-photo",
            handler: "api",
            root: "get",
            steps: {
              get: {
                type: "call",
                target: "photos",
                action: "store.read",
                entity: "Photo",
                next: { found: "ok", notFound: "missing", error: "unavailable" },
              },
              ok: { type: "respond", status: 200 },
              missing: { type: "respond", status: 404 },
              unavailable: { type: "respond", status: 503 },
            },
          },
    ],
    layout: {
      users: { x: 0, y: 0 },
      lb: { x: 200, y: 0 },
      api: { x: 400, y: 0 },
      photos: { x: 600, y: 100 },
    },
  });
}
