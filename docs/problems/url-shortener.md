# Problem design: URL Shortener

This is the first problem pack and the reference for how deep a problem should go. It covers seven scenarios in v0.1 and an advanced analytics scenario in v0.2.

## Brief

Users submit long URLs and receive short codes. Visitors who open a short link are redirected to the long URL. Optional features: custom aliases, expiry, and abuse takedown.

## Scale (given to the candidate)

| Quantity | Value | Derived (shown after the estimation step) |
|---|---|---|
| Creates | 1,000 /s avg, ×3 peak | 86.4 M/day; 158 B links over 5 years |
| Redirects | 100,000 /s avg, ×3 peak | 100:1 read/write |
| Link record | ~500 B | ~79 TB raw over 5 years; ~237 TB with replication factor 3 |
| Code space | 7 chars base62 | 62⁷ ≈ 3.5 × 10¹²; 5-year occupancy ≈ 4.5% |
| Redirect key popularity | Zipf, s ≈ 1.05 over ~2 × 10¹⁰ active links | Ideal-cache hit ratio ≈ 0.81 at 10 GB, 0.86 at 50 GB, 0.90 at 200 GB of cache memory (fill factor 0.7, 500 B per entry) |

## Requirements

| ID | Requirement |
|---|---|
| FR-1 | Create a short link; optional custom alias |
| FR-2 | Redirect a code to its long URL |
| FR-3 | Links may expire; an expired link no longer redirects |
| FR-4 | A disabled (abusive) link stops redirecting within 60 s |
| NFR-1 | Redirect p99 < 50 ms server-side; create p99 < 200 ms |
| NFR-2 | Redirect availability 99.99%; create availability 99.9% |
| NFR-3 | Codes are unique and not enumerable |
| NFR-4 | An acknowledged link is never lost |
| NFR-5 | Creation is protected against abuse (per-client limits) |

## Operations and entities

- **Entity:** `Link { code (key), longUrl, ownerId, createdAt, expiresAt?, status }`.
- **Operations:**

  | Operation | Request | Introduced in |
  |---|---|---|
  | `createLink` | `POST /links` (write, non-idempotent) | S1 |
  | `redirect` | `GET /{code}` (read) | S2 |
  | `disableLink` | `POST /links/{code}/disable` (write, idempotent) | S4 |
  | `purgeExpired` | worker flow | S7 |
  | `recordClick` | consumer flow | S8 |

## Decision points

| ID | Options | Checked against |
|---|---|---|
| `code-strategy` | kgs · random-conditional · counter-range · hash-based | create flow shape (`decision-matches-design`) |
| `redirect-status` | 301 · 302 · 301-with-short-max-age · 307 · 308 | FR-4 (revocation), S8 analytics |
| `replication-mode` | async · semi-sync · sync | NFR-4 (RPO) vs NFR-1 (latency) |
| `expired-status` | 404 · 410 | consistency with flow |
| `code-reuse` | never · after-grace-period | S7: stale caches and bookmarks |

---

## S1: Create a link (write path)

**Story.** "Walk me through what happens when a user creates a short link. How do you guarantee two users never get the same code?"

| | |
|---|---|
| Focus | `createLink` |
| Workload | 1,000 /s avg, 3,000 /s peak; 2% custom aliases, of which 5% conflict; 0.5% invalid URLs |
| Environments | `steady` |
| Dimensions | correctness 0.35 · durability 0.25 · concurrency 0.20 · scalability 0.10 · latency 0.10 |

**Gates**
- `all-success-paths-contain(createLink, store.write*(Link))`: a 201 is never returned without persisting the link.
- `durable-write-before-ack(createLink, Link)`.
- `atomic-uniqueness(createLink, Link, code)`: catches the check-then-insert race.

**Baseline checks**
- `conflict-handled`: random/hash codes retry (bounded); custom aliases return 409.
- `status-for-condition(validateUrl=invalid → 400)`.
- `utilization-below(write path, 0.7, peak)`.
- `p99-below(createLink, 200)`.
- `decision-matches-design(code-strategy)`.
- `no-single-point-of-failure(createLink)`.

**Strategies (NFR-3):** `kgs`, `random-conditional`, `counter-range` (+ `obfuscateId` for non-enumerability), `hash-based`. The anti-pattern `check-then-insert` fails `atomic-uniqueness`. See [03-evaluation.md](../design/03-evaluation.md#stage-5-strategy-recognition).

**Subtle points the evaluator knows about**
- KGS designs still need a conflict path when custom aliases share the namespace. A pre-generated key can equal an alias someone already chose.
- Random 7-char codes reach about 4.5% collisions per insert at 5-year occupancy. The engine reports expected attempts per create; 8 chars make this negligible.
- Counter ranges are collision-free but enumerable unless obfuscated. NFR-3 fails without `obfuscateId`.

**Signals**

| Level | Signal |
|---|---|
| Senior | Idempotency key on create, with a dedupe store |
| Senior | Rate limiting on create, keyed per client (NFR-5) |
| Senior | KGS batch leasing to keep it off the hot path |
| Staff | Obfuscation for counter-based codes |
| Staff | Explicit RPO reasoning via the `replication-mode` decision |

**Debrief prompts.** Why not check-then-insert? What happens when the KGS dies? How would you migrate from 7 to 8 characters?

---

## S2: Redirect (read path)

**Story.** "Now the read side. A visitor clicks a short link. What happens, and how fast?"

| | |
|---|---|
| Focus | `redirect` |
| Workload | 100 k/s avg, 300 k/s peak; 1% unknown codes; 0.5% expired |
| Environments | `steady` (avg), `peak` |
| Physics (S2 only) | No cache requirement yet. The database can serve the load with enough replicas, at a visible cost. |
| Dimensions | correctness 0.40 · latency 0.25 · scalability 0.20 · availability 0.15 |

**Gates**
- `no-path(redirect, 30x without reading Link from a store that holds it)`.
- `status-for-condition(store.read=notFound → 404)`.
- `status-for-condition(checkExpiry=expired → 404|410)`.

**Baseline checks**
- `p99-below(redirect, 50, peak)`.
- `utilization-below(all, 0.7, peak)`.
- `no-single-point-of-failure(redirect)`.
- `decision-consistent(redirect-status, FR-4)`. This check activates fully in S4. S2 shows an informational note.
- `cost-within-budget`: generous here, tightened in S3.

**Signals**

| Level | Signal |
|---|---|
| Senior | Read replicas with `readFrom` chosen deliberately |
| Senior | Ingress through a CDN or edge with an explicit redirect cache rule |
| Staff | Geo-routing for global p99 |

---

## S3: Cache the hot path

**Story.** "Your database bill is enormous and p99 spikes at peak. Popularity is heavily skewed. Fix it."

| | |
|---|---|
| Focus | `redirect`, plus `createLink` (cache priming is optional) |
| Workload | as S2 peak; Zipf s = 1.05; tighter cost budget (a cache-less design blows it) |
| Environments | `peak` |
| Dimensions | cache-efficiency 0.30 · latency 0.25 · correctness 0.25 · cost 0.20 |

**Gates**
- `populate-after-miss(redirect, volatile-kv, Link)`. Only applies if a cache is used.
- `ttl-respects-expiry(volatile-kv, Link)`.

**Baseline checks**
- `hit-ratio-above(0.80)`.
- `utilization-below(durable stores, 0.7, peak)`.
- `p99-below(redirect, 50)`.
- `outcome-handled(volatile-kv, error)`. Fully gated in S4.
- `cost-within-budget`.

**Strategies (read absorption)**

| Strategy | Notes |
|---|---|
| cache-aside | Redis or Memcached |
| read-through | |
| CDN edge cache | 302 + short `max-age`, or 301-with-short-max-age. Valid, but interacts with S4 purge and S8 analytics. |
| Two-tier | In-process near cache + shared cache |

**Signals**

| Level | Signal |
|---|---|
| Senior | Negative caching for unknown codes (protects the database from scans) |
| Senior | Eviction policy matched to skew (LFU or LRU, justified) |
| Senior | Cache sizing from the working set |
| Staff | Stampede protection (request coalescing / single-flight, early refresh). Its effect is shown in v0.2 with the DES. |

**What the simulation makes visible:** cache memory → hit ratio → database utilisation → p99 → cost.

---

## S4: Cache outage and invalidation

**Story.** "A cache shard dies at peak. The same week, trust & safety says phishing links must stop redirecting within 60 seconds of being disabled."

| | |
|---|---|
| Focus | `redirect`, `disableLink` |
| Workload | S3 peak; `disableLink` 5 /s |
| Environments | `shard-down` (one cache shard crashes), `cache-cluster-down` (all shards hang) |
| Dimensions | availability 0.35 · correctness 0.30 · consistency 0.20 · latency 0.15 |

**Gates**
- `outcome-handled(redirect, volatile-kv, error)`: a cache failure must not become a 5xx by itself.
- `invalidation-on-write(disableLink, Link, 60 s)`.

**Baseline checks**
- `error-rate-below(redirect, 0.001, shard-down)`.
- `no-cascading-failure(redirect → createLink, cache-cluster-down)`: the miss storm must not take creation down through a shared database.
- `dependency-timeout-bounded(volatile-kv, 50 ms)`: a hanging cache must not eat the latency budget.
- `decision-consistent(redirect-status, FR-4)`.
- `stable-under-retries(cache-cluster-down)`.
- Invalidation ordering: *update store, then delete cache* passes. *Delete, then update* gets a finding for the stale-repopulation race.

**Valid ways to survive `cache-cluster-down`**
- Size the database for degraded mode (expensive; the simulation shows the cost).
- Shed load: rate-limit or admission control in front of the database, accepting partial redirect failure without a cascade.
- Two-tier cache: near caches keep serving hot keys.
- A circuit breaker on the cache, so failures skip it quickly.

Each of these is accepted. The candidate sees the different availability/cost profile of each.

**Valid invalidation strategies**
- Delete on write.
- TTL ≤ 60 s. Accepted, but the hit-ratio cost shows in S3 and S5 re-evaluation.
- CDN purge, when edge caching is used.
- A 301 without a short `max-age` fails `decision-consistent`: browsers keep permanent redirects, so they cannot be revoked.

**Signals**

| Level | Signal |
|---|---|
| Senior | Circuit breaker on the cache |
| Senior | Bounded staleness by TTL as a safety net |
| Staff | Versioned or CAS invalidation |
| Staff | Explicit blast-radius reasoning (a separate database pool for writes) |

---

## S5: Peak traffic and hot keys

**Story.** "A link goes viral during a sports final. Traffic hits 10× the average, and one link takes 30% of it."

| | |
|---|---|
| Focus | `redirect`, `createLink` |
| Workload | 1 M redirect/s with q₁ = 0.30 on one key; creates ×5 with a 2% abusive client share |
| Environments | `viral-spike` |
| Dimensions | scalability 0.35 · availability 0.25 · latency 0.25 · cost 0.15 |

**Baseline checks**
- `utilization-below(per-shard, 0.85, viral-spike)`: catches a hot key overloading one cache shard.
- `utilization-below(services, 0.8)`, with autoscaling `max` sufficient.
- Load balancer and ingress capacity.
- `p99-below(redirect, 50)`.
- `error-rate-below(redirect, 0.0001)`.
- `rate-limited(createLink, per-client)` (NFR-5).
- `cost-within-budget`, with an overprovisioning finding when idle capacity is excessive.

**Valid hot-key mitigations:** near cache with a short TTL, CDN/edge caching of the hot redirect, read replicas per shard, or key replication across shards.

**Signals**

| Level | Signal |
|---|---|
| Senior | Near cache |
| Senior | Autoscaling bounds sized from peak |
| Staff | Hot-key detection and adaptive replication |
| Staff | Cost-aware headroom (pre-scaling vs autoscaling lag; quantified in v0.2 with the DES) |

---

## S6: Dependency failure

**Story.** "The primary database fails over. Separately, an API instance crashes. What do users see?"

| | |
|---|---|
| Focus | `redirect`, `createLink` |
| Environments | `db-failover` (primary unavailable for `failoverSec`), `instance-crash` (one service replica), `zone-outage` (staff-signal environment) |
| Dimensions | availability 0.35 · durability 0.30 · correctness 0.20 · latency 0.15 |

**Gates**
- `no-acknowledged-data-loss(createLink, db-failover)`, unless `replication-mode` explicitly accepts RPO > 0 *and* NFR-4 is addressed another way (a durable log before ack).
- Creates fail fast during failover with a 503 and retry guidance. No hanging requests.

**Baseline checks**
- `error-rate-below(redirect, 0.01, db-failover)`. Cache hits continue. Misses can use replicas with `readFrom: replica | primary-preferred`.
- `timeout-chain-consistent`.
- `retry-only-idempotent(createLink)`: POST retries need an idempotency key.
- `health-check-detection(lb, ≤ 10 s)`.
- `error-rate-below(redirect, 0.0005, instance-crash)`.

**Valid durability approaches**
- Sync or semi-sync replication: a latency cost, shown in metrics.
- Async replication with an explicit RPO decision.
- Ack after writing to a durable log (`acks=all`, RF ≥ 3) with asynchronous persistence. This is accepted for NFR-4, but `read-your-writes(createLink → redirect)` then requires cache priming on create.

**Signals**

| Level | Signal |
|---|---|
| Senior | Load balancer retries on another instance for GET only |
| Staff | Multi-zone survival |
| Staff | Explicit RPO/RTO statement through decisions |

---

## S7: Edge cases

**Story.** "Let's go through the corners: expired links, unknown codes, invalid input, alias conflicts, and malicious URLs."

| | |
|---|---|
| Focus | `createLink`, `redirect`, `purgeExpired` (worker), safety scan (async consumer) |
| Dimensions | correctness 0.50 · security 0.25 · operability 0.25 |

**Checks**
- Expired → the 404/410 status matches the `expired-status` decision. Expiry is checked on the read path (lazy), not only by the purge job.
- `purgeExpired` runs as an async worker flow with batched deletes. It is not part of the request path.
- Code reuse: `never`, or after a grace period that exceeds the maximum cache TTL and CDN `max-age`. Otherwise stale caches redirect to the wrong destination.
- Unknown codes → 404. Negative caching and per-IP rate limiting counter enumeration scans (signals).
- Invalid URL → 400 before any write.
- Alias conflict → 409.
- Malicious URL: a create-time or async safety scan, `external.call(safe-browsing)`, feeds `disableLink`. This ties the scenario back to S4's invalidation.

---

## S8 (v0.2): Click analytics

**Story.** "Product wants per-link click counts, at most a minute stale."

- **Gate:** `no-sync-write-on-read-path(redirect)`. A database increment per click is a hot-row disaster for viral links.
- **Checks:**
  - an async publish to a log with fire-and-forget semantics, bounded by a local buffer;
  - a stream aggregation into a counter or OLAP store;
  - counts fresh within 60 s;
  - hot-key counter mitigation (pre-aggregation or sharded counters).
- **Decision interplay:** 301 caching hides repeat clicks, so `decision-consistent(redirect-status, analytics)`.

---

## Golden corpus (must pass)

| ID | Design |
|---|---|
| `postgres-redis-kgs` | LB → stateless API ×N → Redis cache-aside (negative caching) → Postgres sharded by code with read replicas; KGS with batch leasing; rate limiter on create |
| `dynamo-redis-random` | API gateway (rate limits) → API → Redis → DynamoDB conditional put of random 8-char codes with a bounded retry |
| `cassandra-range-obfuscated` | API → Memcached → Cassandra; etcd range leases + Feistel obfuscation + base62 |
| `cdn-edge-302` | CDN caching 302s with `max-age = 30 s` (purge on disable) → LB → API → Redis → Postgres |
| `two-tier-dynamo-kgs` | Near cache + Redis + DynamoDB; KGS; circuit breaker on the cache; load shedding in front of the database |
| `log-first-durability` | Create acks after a Kafka write (`acks=all`); a consumer persists to Postgres; the create path primes the cache for read-your-writes |

Each golden design declares the scenario bands it is expected to achieve. CI enforces them.

## Mutant expectations (excerpt)

| Base | Mutation | Expected failure |
|---|---|---|
| postgres-redis-kgs | `insertIfAbsent` → `insert` on the alias path | S1 `atomic-uniqueness` (gate) |
| postgres-redis-kgs | remove `cache.set` after found | S3 `populate-after-miss` (gate), `hit-ratio-above` |
| postgres-redis-kgs | cache error → `fail` | S4 `outcome-handled` (gate) |
| dynamo-redis-random | remove the conflict branch | S1 `conflict-handled` |
| cassandra-range-obfuscated | remove `obfuscateId` | S1 NFR-3 strategy check (enumerable) |
| cdn-edge-302 | decision 302 → 301 | S4 `decision-consistent` |
| two-tier-dynamo-kgs | cache timeout 50 ms → 2,000 ms, `mode: hang` | S4 `dependency-timeout-bounded`, `p99-below` |
| log-first-durability | remove cache priming on create | S6 `read-your-writes` |
| any | `disableLink`: delete cache before the store update | S4 invalidation-ordering finding |
| any | retries `max: ∞`, no jitter | S4 `stable-under-retries` |
| any | add an unconnected Kafka + Elasticsearch | hygiene finding only; score not increased |
