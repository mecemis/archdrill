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
| `code-strategy` | kgs · random-conditional · counter-range · hash-based | create flow shape (`recognize-strategy`) |
| `code-length` | 6 · 7 · 8 (default 7) | simulated collision rate in S1 |
| `redirect-status` | 301 · 302 · 301-with-short-max-age · 307 · 308 | FR-4 (revocation), S8 analytics |
| `replication-mode` | async · semi-sync · sync | NFR-4 (RPO) vs NFR-1 (latency) |
| `expired-status` | 404 · 410 | consistency with flow |
| `code-reuse` | never · after-grace-period | S7: stale caches and bookmarks |

---

## S1: Create a link (write path)

**Story.** "Walk me through what happens when a user creates a short link. How do you generate the code, and how do you guarantee that two users never get the same one, even when they create links at the same moment? What does a user see if they ask for an alias that is already taken?"

| | |
|---|---|
| Focus | `create-link` |
| Workload | 1,000 /s avg, 3,000 /s peak; 97.5% generated codes, 1.9% free custom aliases, 0.1% taken aliases, 0.5% invalid URLs; 158 B links stored (5 years); keyspace 62^`code-length` |
| Environments | `avg`, `peak` |
| Dimensions | correctness 0.30 · concurrency 0.20 · durability 0.15 · availability 0.15 · security 0.10 · latency 0.10 |

**Gates**
- `validates-before-writing`: every 201 path validates the URL first.
- `durable-before-ack`: every 201 path stores the link (`insert` or `insertIfAbsent` → ok) first.
- `atomic-uniqueness`: every 201 path writes with `insertIfAbsent`. A plain put overwrites someone else's link.
- `no-check-then-insert`: no path reads `notFound` and then puts. That is the classic TOCTOU race.
- `serves-peak`: at least 99% of creates succeed at peak.

**Baseline checks**
- `invalid-url-400`, `custom-aliases-supported`, `taken-alias-409`.
- `generated-collision-not-409`: a collision on a code the user did not choose is never their problem.
- `generated-collision-retried`: after a conflict on a generated code, a new code is produced and inserted (`hasSequence`).
- `non-enumerable` (critical): leased counter values must pass `obfuscateId` before encoding.
- `code-strategy` (`recognize-strategy`), compared with the `code-strategy` decision.
- `creates-succeed` (99.9% at peak, critical), `no-single-point-of-failure` (critical), `headroom-at-peak`, `create-p99` (< 200 ms), `errors-handled`, `dead-weight`.

**Strategies (NFR-3):** `kgs`, `random-conditional`, `counter-range` (+ `obfuscateId` for non-enumerability), `hash-based`. The anti-pattern `check-then-insert` fails `no-check-then-insert` and `atomic-uniqueness`. See [03-evaluation.md](../design/03-evaluation.md#stage-5-strategy-recognition).

**Subtle points the evaluator knows about**
- KGS and counter designs still need a conditional insert and a retry, because custom aliases share the namespace with generated keys. The simulation counts that collision at the share of the keyspace aliases hold.
- Hash-based designs must salt their retry (`rehashWithSalt`). Hashing the same URL again gives the same code and collides every time.
- A key generator is a single point of failure for generated codes even though custom aliases bypass it. Redundancy is judged per kind of request.
- Random 7-character codes collide on about 4.5% of inserts at 5-year occupancy. One retry still fails about 0.2% of creates (below the 99.9% target); two retries or 8 characters meet it. 6 characters cannot hold 158 B links at all.
- Counter ranges are collision-free but enumerable unless obfuscated.

**Signals**

| Level | Signal | Status |
|---|---|---|
| Senior | Rate limiting on create, on the ingress route (NFR-5) | built |
| Senior | Allocation calls batched off the hot path | built |
| Senior | Idempotency key on create, with a dedupe store | later |
| Staff | Explicit RPO reasoning via the `replication-mode` decision | later (M4) |

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

**As built (M4)** (`s4-cache-outage`)
- Environments: `peak` (healthy), `node-down` (one cache node crashes) and `cluster-down` (every cache node hangs), all at 300,000 redirects, 3,000 creates and 5 disables a second.
- Gates: `cache-failure-falls-back`, `disabled-never-redirected` (every 3xx path checks the status) and `invalidated-within-60s`.
- Baseline: `disabled-answer`, `disable-errors-handled`, `survives-node-loss` (99.99%, critical), `node-loss-p99`, `no-cascade` (creates at 99.9% while the cache is gone, critical), `cache-timeout` (50 ms, major), `stable-under-retries` (critical), `retries-bounded` and `revocable-redirects` (301 and 308 are forbidden).
- Signals: a circuit breaker on the cache (senior); redirects that keep working without any cache (staff).
- Surviving the miss storm: the Postgres golden handles redirects in their own service with a 60,000 calls/s bulkhead to the database, so redirects degrade to 20% while creates stay at 100%; on-demand DynamoDB absorbs the whole peak; a database sized for the full read peak keeps redirects at 100% and breaks the S3 budget. An unreplicated Memcached tier fails node loss and cascades.

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

**As built (M5)** (`s5-hot-keys`)
- Environments: `avg` (an average day, 100,000 redirects a second, no viral link) and `spike` (a million redirects a second, 30% of them for one link, plus the usual creates).
- Gate: `serves-spike` (99% of redirects succeed during the spike).
- Baseline: `spike-availability` (99.99%, critical), `hot-shard-headroom` (no component or shard above 85%, major), `spike-p99`, `creates-unaffected` (critical), `within-budget` (an average day under $40,000, major) and `idle-fleet` (minor).
- Signals: a near cache, autoscaling services and rate-limited creation (senior).
- Valid answers in the corpus: the Postgres golden (a 10-second near cache, both services autoscaling, a rate-limiting gateway) and the DynamoDB golden (autoscaling with a near cache). Without a near cache, the viral link's 300,000 lookups a second saturate one Redis shard while the tier averages 68%; a fleet fixed at the spike's size breaks the average-day budget.

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

**As built (M4)** (`s6-dependency-failure`)
- Environments: `failover` (a primary of the link store is lost and connections to it hang) and `instance-crash` (one instance of the redirect handler crashes), at the S4 peak. The zone outage is left for later.
- Gates: `no-acknowledged-loss` (from the `replication-mode` decision: asynchronous replication loses about one second of creates) and `creates-fail-fast` (store calls time out within a second).
- Baseline: `redirects-survive-failover` (99.9%, critical), `failover-p99`, `survives-instance-loss` (99.99%, critical; N+1 sizing), `instance-loss-p99`, `no-unsafe-retries` (the conditional insert is not retried, major), `create-errors-handled`, `redirect-errors-handled` and `stable-under-retries`.
- Signals: a circuit breaker on the store (senior).
- Timeline (M8): `failover-over-time`, two minutes at the peak, with the primary failing over from 30 s to 75 s. It has two checks:
  - `redirects-through-failover`: redirects stay at 99.9% throughout (critical);
  - `creates-recover-after-failover`: creates are back within 5 s of the new primary.

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

**As built (M6)** (`s7-edge-cases`)

- Workload: peak traffic with 2% expired and 0.5% disabled redirects; one create in 500 is malicious; the purge job has 500 expired links a second. A second environment makes the URL-safety API hang.
- Gates: malicious links are stopped (`unsafe-content-stopped`: every path that stores a link checked it first, or published `link-created` to a consumer that checks it and disables the link), disabled links never redirect, and expiry is checked on the read path.
- Correctness: the expired status matches the `expired-status` decision; redirects never delete; codes are not reused right away (`code-reuse` decision), and reused codes are never served as cacheable 301/308 redirects; unknown codes 404, invalid URLs 400, taken aliases 409.
- Security: an asynchronous scan disables within 10 s (p99 lag) and invalidates caches within 50 s, and failed scans answer 503 so the queue retries.
- Operability: the purge job deletes, in batches; consumers and jobs keep up; nothing (the API quota included) runs above 85%; creation survives the URL-safety API going down; calls to it time out within a second.
- Signals: per-client rate limits on redirects, negative caching, and creation that publishes instead of waiting for a scan.

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

**As built (M6).** The corpus in `packages/content/problems/url-shortener/corpus/` holds seven golden designs, covering all four code strategies, and 66 mutants. Two of them pass S7 in different ways: the Postgres design publishes every new link to a managed queue that a worker scans; the DynamoDB design checks each link before the create answers and publishes only the links whose check failed, for a batched rescan.

| ID | Create path | Read path |
|---|---|---|
| `postgres-redis-cache-aside` | KGS ×2 with batches of 1,000, one retry, behind a rate-limiting gateway; publishes `link-created` | an autoscaling Redirect API with a near cache → Redis cache-aside with negative caching → Postgres behind a bulkhead; a worker scans new links and purges expired ones (all seven scenarios) |
| `postgres-redis-fixed-fleet` | as above, without the gateway | the same with fixed fleets and no near cache (expected not to pass S5) |
| `dynamodb-redis-cache-aside` | random 8-character codes, one retry; a URL check before answering, failing open into a rescan | an autoscaling service with a near cache → Redis cache-aside → DynamoDB; the same service purges in batches of 25 |
| `mysql-memcached-cache-aside` | etcd ×3 range leases of 10,000 + `obfuscateId` + base62 | Memcached cache-aside → MySQL |
| `dynamodb-direct` | random 7-character codes, two retries | DynamoDB only (expected not to pass S3) |
| `postgres-hash-based` | 8-character URL hashes, one retry with `rehashWithSalt` | none (write path only) |
| `postgres-sized-for-cache-loss` | random 8-character codes, one retry | Redis → Postgres sized for the full read peak (expected not to pass S3) |

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
