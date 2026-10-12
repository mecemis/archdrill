# 02 — Domain model

The model has three layers. Each layer is owned by a different party.

| Layer | Owner | Shared across scenarios? |
|---|---|---|
| **Catalog**: component kinds, flavors, sizes, capabilities, actions | Platform | Yes, global |
| **Problem pack**: brief, requirements, entities, operations, decision points, scenarios | Author | Yes, per problem |
| **Attempt**: architecture, flows, decisions, estimates, layout | Candidate | One per attempt, shared by all scenarios |

All three are validated with Zod schemas in `packages/model`. The schemas are the single source of truth for TypeScript types. Problem packs are YAML, compiled and validated at build time.

---

## 1. Catalog

### Component kinds and flavors

A **kind** is a generic role. A **flavor** is a concrete technology preset for that role. Evaluation reasons about kinds and capabilities. The UI shows flavors, because candidates say "Redis", not "volatile key-value store".

| Kind | Example flavors | Base capabilities |
|---|---|---|
| `client` | browser, mobile, api-client | `traffic-source` |
| `dns` | route53, cloud-dns | `name-resolution`, `geo-routing` |
| `cdn` | cloudfront, cloudflare, fastly | `edge-cache`, `tls-termination` |
| `load-balancer` | alb, nlb, nginx, envoy | `load-balancing`, `health-checking` |
| `api-gateway` | kong, aws-api-gateway, apim | `routing`, `rate-limiting`, `authn` |
| `service` | generic stateless service | `stateless-compute` |
| `worker` | queue consumer, cron job | `async-compute` |
| `cache` | redis, memcached, valkey | `volatile-kv`, `ttl`; plus `atomic-increment` for redis |
| `relational-db` | postgres, mysql | `durable-store`, `unique-constraint`, `conditional-write`, `transactions`, `secondary-index`, `range-scan` |
| `wide-column-db` | cassandra, scylla | `durable-store`, `conditional-write` (LWT, costly), `ttl`, `range-scan` (within partition) |
| `key-value-db` | dynamodb | `durable-store`, `conditional-write`, `ttl`, `atomic-increment` |
| `object-storage` | s3, blob-storage | `durable-store`, `blob-store` |
| `log` | kafka, kinesis, event-hubs | `async-buffer`, `ordered-partition-log`, `replayable`, `pubsub` |
| `queue` | rabbitmq, sqs, service-bus | `async-buffer`, `competing-consumers`, `delayed-delivery` |
| `id-generator` | kgs (pre-generated keys), snowflake service | `id-generation` |
| `coordination` | etcd, zookeeper | `consensus`, `leases`, `atomic-increment` |
| `rate-limiter` | redis-backed, envoy | `rate-limiting` |
| `stream-processor` | flink, kafka-streams | `stream-aggregation` |
| `olap-store` | clickhouse, druid | `durable-store`, `analytical-query` |
| `search` | elasticsearch, opensearch | `full-text-search` |
| `external` | third-party API (e.g. safe-browsing) | declared per problem |

Capabilities can depend on configuration. For example, a relational database with `replication: async` keeps `durable-store`, but its failover facts carry `rpo > 0`.

### Sizes, not raw numbers

Candidates choose a **size preset** (`s`, `m`, `l`, `xl`) and counts (replicas, shards). They never type raw capacities. The "physics" lives in the catalog:

- capacity per replica for each operation class;
- base latency with a coefficient of variation;
- memory and storage limits;
- unit cost.

This keeps scores honest (nobody can set `maxQps: 10_000_000`) and lets authors calibrate numbers in one place. Every number has a `source` note, and the catalog documents its assumptions.

```yaml
# content/catalog/cache.yaml (excerpt)
kind: cache
flavors:
  redis:
    sizes:
      m: { memoryGb: 26, opsPerSec: { read: 150000, write: 120000 }, latencyMs: { base: 0.5, cv: 0.6 }, costPerHour: 0.32 }
      l: { memoryGb: 52, opsPerSec: { read: 200000, write: 160000 }, latencyMs: { base: 0.5, cv: 0.6 }, costPerHour: 0.64 }
    notes: "Single-threaded command execution; ballpark for small values on a cache-optimised instance. Order-of-magnitude only."
```

### Actions and outcomes

Each capability exposes **actions**. Every action has a closed set of **outcomes**. Flows branch on outcomes. That is what makes conditional behaviour explicit and evaluable.

| Capability | Action | Outcomes | Notes |
|---|---|---|---|
| `volatile-kv` | `cache.get(entity, key)` | `hit`, `negativeHit`, `miss`, `error` | hit probability comes from the simulation; `negativeHit` is only feasible when a reachable step stores negative entries for the same entity in the same cache |
| | `cache.set(entity, key, ttl)` | `ok`, `error` | |
| | `cache.setNegative(entity, key, ttl)` | `ok`, `error` | caches "does not exist" |
| | `cache.delete(entity, key)` | `ok`, `error` | |
| `durable-store` | `store.read(entity, key)` | `found`, `notFound`, `error` | |
| | `store.insert(entity)` | `ok`, `error` | **unconditional put**: overwrites an entity with the same key, so uniqueness is not guaranteed |
| | `store.update(entity, key)` | `ok`, `notFound`, `error` | |
| | `store.delete(entity, key)` | `ok`, `error` | |
| `conditional-write` | `store.insertIfAbsent(entity, key)` | `ok`, `conflict`, `error` | atomic; e.g. `INSERT … ON CONFLICT DO NOTHING`, `attribute_not_exists` |
| `id-generation` | `ids.allocate(batchSize?)` | `ok`, `error` | key generation service; with a batch size the call happens once per batch, so its load and latency are divided by the batch size |
| `leases` | `coord.leaseRange(batchSize?)` | `ok`, `error` | counter-range allocation from a consensus store; the batch size is the range size |
| `async-buffer` | `publish(topic)` | `ack`, `error` | non-blocking continuation |
| `rate-limiting` | `ratelimit.check(scope)` | `allowed`, `limited`, `error` | |
| `edge-cache` | (configured on the ingress route) | | caches responses by status and `Cache-Control` |
| `external` | `external.call(name)` | `ok`, `rejected`, `error` | e.g. URL safety scan |
| *(local)* | `logic(name)` | declared per logic step | runs inside the actor: `validateUrl → valid/invalid`, `hasCustomAlias → custom/generated`, `checkExpiry → valid/expired`, `checkStatus → active/disabled`, `generateRandomCode`, `hashUrl`, `rehashWithSalt`, `encodeBase62`, `obfuscateId` |

Every outcome a step can produce must lead somewhere: another step, a `respond`, or an explicit `fail`. An **unhandled outcome** is a validation warning, and the evaluation reports it as a finding with the exact step highlighted. The default semantics are documented: an unhandled `error` propagates as a failure, and an unhandled `miss` or `notFound` is treated as a bug.

---

## 2. Problem pack

```yaml
# content/problems/url-shortener/problem.yaml (abridged)
id: url-shortener
title: URL Shortener
level: [senior, staff]
brief: |
  Design a service that turns long URLs into short codes and redirects visitors…
scale:
  createsPerSec: { avg: 1000, peakMultiplier: 3 }
  redirectsPerSec: { avg: 100000, peakMultiplier: 3 }
  retentionYears: 5
  avgLinkBytes: 500
requirements:
  - { id: FR-1, kind: functional, text: "Create a short link for a long URL; optional custom alias" }
  - { id: FR-2, kind: functional, text: "Redirect a short code to its long URL" }
  - { id: FR-3, kind: functional, text: "Links expire at an optional expiry time" }
  - { id: FR-4, kind: functional, text: "Abusive links can be disabled; disabled links stop redirecting within 60 s" }
  - { id: NFR-1, kind: non-functional, text: "Redirect p99 < 50 ms server-side" }
  - { id: NFR-2, kind: non-functional, text: "Redirect availability 99.99%, create 99.9%" }
  - { id: NFR-3, kind: non-functional, text: "Codes are unique and not enumerable" }
  - { id: NFR-4, kind: non-functional, text: "An acknowledged link is never lost" }
entities:
  - { name: Link, key: code, fields: [code, longUrl, ownerId, createdAt, expiresAt, status], avgBytes: 500 }
operations:
  - { id: createLink, method: POST, path: /links, class: write, idempotent: false, requirements: [FR-1, NFR-3, NFR-4] }
  - { id: redirect,   method: GET,  path: "/{code}", class: read, idempotent: true, requirements: [FR-2, FR-3, NFR-1, NFR-2] }
  - { id: disableLink, method: POST, path: "/links/{code}/disable", class: write, idempotent: true, requirements: [FR-4], introducedIn: s4-cache-failure-invalidation }
decisionPoints:
  - id: redirect-status
    question: "Which redirect status do you return?"
    options: [301, 302, 301-with-short-max-age, 307, 308]
    requirements: [FR-4]
  - id: code-strategy
    question: "How are short codes generated?"
    options: [kgs, random-conditional, counter-range, hash-based]
scenarios: [s1-create, s2-redirect, s3-cache, s4-cache-failure-invalidation, s5-peak, s6-dependency-failure, s7-edge-cases]
```

Requirements carry stable IDs. Every check declares the requirement IDs it verifies, which gives a **traceability matrix** (requirement → checks → scenarios) that the UI can show as coverage.

### Scenario definition

```yaml
# content/problems/url-shortener/scenarios/s4-cache-failure-invalidation.yaml (abridged)
id: s4-cache-failure-invalidation
title: "Cache outage and invalidation"
order: 4
prerequisites: [s3-cache]
story: |
  Two things happen in the same week. A Redis shard dies at peak, and trust & safety
  asks that phishing links stop redirecting within a minute of being disabled.
focusOperations: [redirect, disableLink]
workload:
  rates: { redirect: "peak", createLink: "avg", disableLink: 5 }
  keys: { distribution: zipf, s: 1.05, population: 2.0e10 }
  notFoundShare: 0.01
environments:            # each environment is evaluated separately
  - id: shard-down
    faults: [{ target: { capability: volatile-kv }, scope: one-shard, state: down, mode: crash }]
  - id: cache-cluster-down
    faults: [{ target: { capability: volatile-kv }, scope: all, state: down, mode: hang }]
dimensions: { correctness: 0.30, availability: 0.35, consistency: 0.20, latency: 0.15 }
checks:
  - { use: outcome-handled, params: { operation: redirect, capability: volatile-kv, outcome: error }, gate: true }
  - { use: error-rate-below, params: { operation: redirect, environment: shard-down, max: 0.001 }, weight: 3 }
  - { use: no-cascading-failure, params: { from: redirect, to: createLink, environment: cache-cluster-down }, weight: 3 }
  - { use: dependency-timeout-bounded, params: { capability: volatile-kv, maxMs: 50 }, weight: 2 }
  - { use: invalidation-on-write, params: { operation: disableLink, entity: Link, maxStalenessSec: 60 }, gate: true }
  - { use: decision-consistent, params: { decision: redirect-status, requirement: FR-4 }, weight: 2 }
  - { use: circuit-breaker-on-dependency, params: { capability: volatile-kv }, signal: senior }
hints: [ … three levels … ]
debrief: debrief/s4.md
```

Scenarios **never** let the candidate change workload, faults, or physics. The candidate controls design, configuration, flows, and decisions. The scenario controls the world.

---

## 3. Attempt: what the candidate builds

```text
Attempt
├── problemId, schemaVersion, createdAt, updatedAt
├── architecture
│   ├── components[]   { id, kind, flavor, label, size, config, zones[], data[] }
│   └── connections[]  { id, from, to, mode: sync|async, protocol, policy }
├── flows[]            one per operation (shared by all scenarios)
├── decisions{}        decisionPointId → option (+ optional note)
├── estimates{}        (phase 2)
├── layout{}           componentId → {x, y}   (presentation only; never evaluated)
└── history            snapshots taken when a scenario first passes
```

### Component configuration (examples)

| Kind | Config fields |
|---|---|
| `service` | `replicas`, `autoscaling {min, max, targetUtilization}`, `zones` |
| `cache` | `shards`, `replicasPerShard`, `eviction (lru\|lfu\|ttl-only)`, `defaultTtlSec`, `clientSideNearCache {enabled, ttlSec, maxItems}` |
| `relational-db` | `shards`, `shardKey`, `readReplicasPerShard`, `replication (async\|semi-sync\|sync)`, `failoverSec`, `readFrom (primary\|replica\|primary-preferred)` |
| `key-value-db` | `capacityMode (on-demand\|provisioned)`, `rcu`, `wcu`, `globalTables` |
| `log` | `partitions`, `replicationFactor`, `acks (1\|all)`, `retentionHours` |
| `load-balancer` | `healthCheck {intervalSec, unhealthyThreshold}`, `retryIdempotent` |
| `cdn` | `cacheRules [{status, maxAgeSec}]`, `purgeSupported` |

`data[]` binds entities to stores, for example `{ entity: Link, key: code, constraints: [unique(code)] }`. A `store.read(Link)` against a store that does not hold `Link` is a validation error.

### Connection policy

```yaml
policy:
  timeoutMs: 50
  retry: { max: 2, backoff: exponential, baseMs: 10, jitter: full, onlyIdempotent: true }
  circuitBreaker: { failureRateThreshold: 0.5, windowSec: 10, openSec: 5 }   # optional
```

### Flows

A flow implements one operation. Each operation's **ingress route** (client → CDN → LB → handler service) is derived from the topology. If several routes exist, the candidate picks one. The candidate then records the **handler steps** as a small DAG:

```yaml
operation: redirect
ingress: [client, cdn, lb, link-api]     # derived; CDN behaviour comes from its cacheRules
handler: link-api
root: get-cache
steps:
  get-cache:   { call: { target: redis, action: cache.get, entity: Link, key: code }, on: { hit: expiry-hit, miss: read-db, error: read-db } }
  expiry-hit:  { logic: checkExpiry, on: { valid: r302, expired: r410 } }
  read-db:     { call: { target: links-db, action: store.read, entity: Link, key: code }, on: { found: expiry-db, notFound: neg-cache, error: r503 } }
  expiry-db:   { logic: checkExpiry, on: { valid: populate, expired: r410 } }
  populate:    { call: { target: redis, action: cache.set, entity: Link, key: code, ttlSec: 3600 }, on: { ok: r302, error: r302 } }
  neg-cache:   { call: { target: redis, action: cache.setNegative, entity: Link, key: code, ttlSec: 60 }, on: { ok: r404, error: r404 } }
  r302:        { respond: 302 }
  r404:        { respond: 404 }
  r410:        { respond: 410 }
  r503:        { respond: 503 }
```

Rules:

- A `call` step must use an existing connection from its actor to its target. If the topology does not support the flow, the flow is invalid. The candidate cannot describe behaviour the architecture cannot perform.
- `publish` steps continue immediately. The message is consumed by a **consumer flow** bound to the topic, with a worker as its handler.
- Service-to-service calls (`invoke`) compose flows: the callee's operation flow is inlined during analysis, with a depth limit.
- The candidate defines **logic**: which branch leads where. The scenario defines **probabilities**: hit ratio, not-found share, fault states. Setting "hit ratio = 100%" is not something a candidate can do.
- Flows are per operation and shared across scenarios. The redirect flow written in S2 is refined in S3 (cache) and S4 (error handling). Earlier scenarios are re-evaluated automatically.

### Decisions

Decisions are structured choices for the decision points a problem defines. They exist because some interview trade-offs cannot be inferred from a diagram. Making them explicit is both more reliable and closer to how candidates should talk in an interview. Checks evaluate decisions:

- for **consistency with requirements**: for example, 301 together with FR-4 (revocation) means browsers cache the redirect permanently, so revocation is impossible;
- for **consistency with the design**: for example, a decision of `random-conditional` while the create flow uses an unconditional `store.insert`.

A decision point may declare a **default** that is assumed until the candidate decides. Workloads can read decisions: the URL shortener's keyspace takes its length from the `code-length` decision (default 7), so choosing 6, 7 or 8 characters changes the simulated collision rate.

---

## 4. Invariants (enforced by schema and validators)

1. IDs are unique within their collection. References (connections, flow steps, data bindings) resolve.
2. A `call` step's actor → target pair has a connection whose `mode` matches the action (async actions use async connections).
3. An action is offered by at least one capability of the target.
4. Every outcome of every step is handled, or is listed as an explicit unhandled warning.
5. Flows are acyclic. Retries are expressed as connection policy, not as cycles.
6. Layout never influences evaluation.
7. Attempts carry `schemaVersion`. Migrations are pure functions with tests. There are no no-op migrations.
