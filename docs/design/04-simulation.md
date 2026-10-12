# 04 — Simulation

The simulation turns a design plus a scenario environment into **metrics**: load, utilisation, latency percentiles, error rates, hit ratios, availability, and cost. Metric checks consume these numbers.

There are two engines:

| Engine | Phase | Use | Speed |
|---|---|---|---|
| **Analytic** (steady state) | v0.1 | Every scenario, every edit | ~1–5 ms per environment (measured) |
| **Discrete-event (DES)** | v0.2 | Timeline scenarios: cold-cache stampede, retry storms, autoscaling lag, failover timelines | < 2 s in a Web Worker |

Both engines are deterministic. The analytic engine is closed-form plus a fixed-point iteration. The DES uses a seeded PRNG, and every scenario carries a seed.

---

## Analytic engine

### Notation

- `λ_o`: offered rate of operation `o` (requests per second), from the scenario workload.
- `P_o`: the set of paths of operation `o`, from analysis.
- `π(p)`: probability of path `p`, the product of the outcome probabilities along it.
- `v(n, p)`: number of times component `n` is visited on path `p`, including ingress hops.
- `a(n, p)`: expected attempts per visit, after retries.

### 1. Request classes and outcome probabilities

Each outcome probability comes from the scenario, never from the candidate.

The workload splits each operation's traffic into **request classes**, each with a share and a set of facts. For redirect these are:

| Class | Share | Facts |
|---|---|---|
| `live` | 98.5% | the code exists and is active |
| `expired` | 0.5% | the code exists but has expired |
| `unknown` | 1% | the code does not exist |

Path probabilities are computed per class and then mixed by share: `π(p) = Σ_c share_c · Π_steps P(outcome | c)`. Working per class keeps outcomes correlated the way they are in reality. An unknown code always misses the cache unless it is negatively cached, and it is never found in the store. Treating outcomes as independent would get both wrong.

| Outcome | Source |
|---|---|
| `cache.get = hit` | cache model (below), for classes whose key exists |
| `cache.get = negativeHit` | negative-entry cache model, for classes whose key does not exist; only when negative caching is live |
| `store.read = found` / `notFound` | the class's `exists` fact |
| `checkExpiry = expired` | the class's `expired` fact |
| `checkStatus = disabled` | the class's `disabled` fact |
| `validateUrl = invalid` | the class's `invalidInput` fact |
| `insertIfAbsent = conflict` | for random codes: occupancy `N / K` at the scenario horizon (`N` links, `K` keyspace); custom aliases: `aliasConflictShare` (arrives with the write path) |
| `*.error` | fault state of the target (M4), plus overload drops, plus the timeout fraction (M4) |

### 2. Load propagation

```
L_n = Σ_o λ_o · Σ_{p ∈ P_o} π(p) · v(n, p) · a(n, p)
```

Loads are split by operation class (read or write), because capacities differ. Async `publish` steps add load to the log and to the consumer flow's components, but not to the caller's latency.

### 3. Cache model

**Key popularity.** Keys follow a Zipf(s) distribution over a population of `N` keys. Key `k` has rate `λ q_k`, where `q_k = k^{−s} / H(N, s)`. With `N ≈ 10¹⁰`, per-key sums are infeasible. Ranks are grouped into ~256 log-spaced buckets, and sums become bucket integrals. Generalised harmonic numbers `H(n, s)` use the Euler–Maclaurin approximation.

**Capacity-limited hit ratio (LRU).** This uses **Che's approximation**. The *characteristic time* `t_C` solves

```
Σ_k (1 − e^{−λ_k t_C}) = C
```

where `C` is the cache capacity in items. Capacity is `shards × memoryGb × fillFactor / itemBytes`, with `fillFactor` covering allocator and metadata overhead. Then `hit_k = 1 − e^{−λ_k t_C}`. For LFU, or as an upper bound, the ideal top-`C` cache gives `H(C, s) / H(N, s)`.

**TTL-limited hit ratio.** Entries expire `T` seconds after population. For a key with rate `λ_k`, each TTL cycle contains one miss followed on average by `λ_k T` hits, so `hit_k = λ_k T / (1 + λ_k T)`.

**Combined.** For LRU with a TTL that is not refreshed on reads (Redis `SET … EX` semantics):

```
hit_k ≈ min(1 − e^{−λ_k t_C}, λ_k T / (1 + λ_k T))
```

The first term is the capacity limit (Che); the second is the TTL limit. Taking the minimum is a bound-based approximation, and is documented as such. If the TTL is refreshed on reads, the TTL acts as a reset timer and the second term becomes `1 − e^{−λ_k T}`. The aggregate hit ratio is `Σ_k q_k hit_k`. This is where design decisions become visible: halving memory, or a 60-second TTL for takedown compliance, changes the hit ratio by an amount the candidate can see.

**Negative caching** applies the same model to not-found keys with their own TTL. Positive and negative entries compete for the same memory, which is split between them in proportion to their lookup rates. This is a simple, documented approximation.

**Near cache (two-tier).** A small in-process cache with its own capacity per service replica and its own TTL sits in front. Its misses feed the shared cache.

**Hot keys and shards.** Keys hash to shards. The load on the hottest shard is approximately

```
λ_cache · (q_1 + (1 − q_1) / S)
```

where `S` is the shard count and `q_1` the hottest key's share. Viral-spike workloads can override `q_1` directly, for example "one link takes 30% of traffic". `utilization-below` uses the per-shard value. This is what makes the hot-key problem show up.

### 4. Capacity, utilisation, and queueing latency

- **Capacity.** Reads are served by every instance (`shards × replicas`). Writes are served by every instance for stateless services, but only by each shard's primary for replicated stores (`writeScaling: primaries`). Utilisation is `ρ = reads / readCapacity + writes / writeCapacity`. Managed, zone-redundant offerings (a managed load balancer, DynamoDB) count as one unit with the catalog's capacity. For autoscaling services (later), `c` is the smallest count in `[min, max]` that keeps `ρ ≤ targetUtilization`; the lag is a DES topic.
- **Mean service time.** `S` is the catalog base latency for the size preset.
- **Concurrency.** By Little's law, a component that serves `capacity` requests per second with service time `S` works on `c = capacity × S` requests at once. That `c` is the server count used by the queueing model.
- **Waiting time.** For `ρ < 1`, M/M/c waiting is computed **exactly** (Erlang C) through the numerically stable Erlang B recursion `B(k) = a·B(k−1) / (k + a·B(k−1))`, with `C = c·B / (c − a(1 − B))`. Beyond 5,000 servers the O(c) cost is not worth it, and Sakasegawa's approximation is used instead:

  ```
  W_q ≈ ρ^(√(2(c+1)) − 1) / (c · (1 − ρ)) · S
  ```

  It was measured to stay within 4% of the service time of the exact value across c = 2…100 and ρ = 0.5…0.95. Its *relative* error is large only where waits are negligible. Utilisation is capped at 0.98 inside the formula.
- **Overload wait.** Requests that an overloaded component (`ρ > 1`) still serves have waited in a queue that keeps growing until callers give up. Until timeouts arrive (M4), this is a fixed, documented wait of **1 s**. Without it, overloaded designs would look fast, because the excess is rejected rather than queued. Two limits follow:
  - Between `ρ = 0.98` and `1.0` the queueing wait stays at its capped value, and it jumps to the overload wait above 1.0.
  - Headroom checks (`utilization-below`, usually at 0.8) keep scenarios away from that region.
- **Node latency.** Moments are `mean = S + W_q` and `variance = (cv·S)² + W_q²`.
- **Network hops.** Each connection adds a round trip of 0.5 ms within a zone. Zone and region placement arrive with the failure scenarios.

### 5. Path latency and percentiles

- **Per path.** Path latency is the sum of its hop and node latencies. Means and variances add, and the path is moment-matched to a **Gamma** distribution. A rejected call fails fast: it costs the round trip, not the service time.
- **Per operation.** Operation latency is the **mixture** over the paths of *successful* requests, weighted by `π(p)`. p50, p95, and p99 are found by bisection on the mixture CDF. Failed requests are reported by the success rate instead, because fast failures would otherwise pull the tail down. Latency checks also fail outright when fewer than 99% of requests succeed.
- **Mixture, not maximum.** A cache hit and a cache miss are different distributions, and the p99 is often decided by the miss path. Taking the longest path instead would hide this.

### 6. Overload, timeouts, retries: the fixed point

Loads depend on error rates (retries add attempts, fallbacks shift load). Error rates depend on loads (overload, timeouts). Hit ratios depend on lookup rates and feed back into loads.

In v0.1 (M2), steps 1–3 and the cache update run with damping 0.5 until the largest change is below 1e−7, with at most 80 iterations. Timeouts and retries (steps 5–7) arrive with M4. The planned full loop is:

```
repeat until converged (Δ < 1e−4) or 100 iterations:
  1. loads L_n           ← propagate(λ, π, attempts)
  2. utilisation ρ_n     ← L_n / capacity_n
  3. overload drop d_n   ← max(0, 1 − 1/ρ_n)      (excess beyond capacity is shed or times out)
  4. latency dists       ← queueing model with min(ρ_n, 0.98)
  5. timeout fraction t_c ← P(latency(target) > timeout_c), for each connection c
  6. error probability   e_c ← 1 − (1 − fault_c)(1 − d_target)(1 − t_c)
  7. attempts            a_c ← Σ_{k=0}^{R_c} e_c^k   (R_c = retry max; only if the operation is idempotent or keyed)
  8. outcome probs       ← error outcomes get e_c; other outcomes renormalised
  apply damping (0.5) to the updates
```

- **Converged**: report metrics.
- **Diverged**: `L` grows each iteration while `ρ > 1` somewhere. Report **unstable: retry amplification** with the components involved. This is the analytic signature of a retry storm, and `stable-under-retries` fails.
- **Latency of failed calls.** A failed call costs `timeout` for hangs, or roughly 0 for fast failures such as connection refused (`mode: crash`). Backoff between retries adds to path latency.

**As built (M4).** Every call a flow step makes goes through its connection's policy (`timeoutMs`, `retries`, `backoff`, `jitter`, `circuitBreaker`, `maxRps`). One attempt fails for four independent reasons:

| Reason | Probability | Cost of the failed attempt |
|---|---|---|
| shed by the caller's bulkhead | `1 − maxRps / offered`, computed from the current call rate | ≈ 0 (local rejection) |
| a fault at the target | the fault's share for reads or writes | one round trip if refused, the timeout (or the 30 s client default) if hanging |
| overload at the target | `1 − 1/ρ` | one round trip |
| served after the caller's timeout | `P(latency > timeout)` from the target's latency Gamma | the timeout |

With attempt failure `e` and `R` retries, a call fails with probability `e^(R+1)`; attempts per call are `Σ e^k`, and all of them load the target (timed-out attempts still cost it work). A successful call after `k` failed attempts pays their cost plus the backoff before each retry (10 ms doubling; full jitter halves the mean). A successful call came back before the timeout, so its latency is the target's Gamma truncated at the timeout.

A circuit breaker counts failures that come back from the dependency (faults, overload, timeouts), not the caller's own bulkhead rejections. It opens on a ramp from 50% to 75% failing attempts, which stands for the share of time a real breaker spends open; a hard switch would flap in a steady-state model. While open it fails calls at once and sends nothing to the dependency. It is one breaker per connection, so a failure of one shard counts against all of them.

The fixed point now relaxes overload, timeout shares and call rates, with damping 0.5 that shrinks to 0.25 after 40 iterations and 0.1 after 120 (at most 200). The queueing wait ramps to the overload wait between 98% and 102% utilisation, so timeouts do not jump at exactly 100%.

**Warm start and metastability.** The loop starts from caches warmed at nominal load: starting cold is a shock of its own. Designs with retries are solved a second time from cold caches. Components that stay overloaded there but not in the healthy state are reported as **metastable**: retries keep them overloaded once something tips them over (a cache flush, a deploy), so the healthy numbers only hold while nothing goes wrong.

### 7. Faults

| Fault | Effect |
|---|---|
| `down` (`mode: crash`) | calls fail fast (`e = 1`, latency ≈ 0 + backoff) |
| `down` (`mode: hang`) | calls fail at the timeout (`e = 1`, latency = timeout) |
| `slow(k)` | `S × k` |
| `degraded(f)` | capacity × `f` |
| `partition(a, b)` | connection `a → b` behaves as `down`/`hang` |
| `scope: one-shard \| one-replica \| one-zone \| all` | which part of the component is affected; redundancy and failover config determine what survives |
| `failover(sec)` | for primary/replica stores: the primary is unavailable for `failoverSec` (from config), then promoted. Writes acknowledged under async replication within the replication lag window are counted as **potentially lost** (`no-acknowledged-data-loss`). |

Each scenario environment is evaluated as its own steady state, for example "during the cache outage". Metric checks name the environment they assert on.

**As built (M4).** Faults pick components by role, not id (`capability`, `kind`, `handlerOf: <operation>`, `holds: <entity>`), so a scenario works with any design:

- `down` with `scope: all` fails every call; `one-node` is absorbed by replicas (capacity drops by one instance), or loses that node's shard of keys without them; `one-shard` loses a shard with all its replicas. `mode: hang` makes calls wait for the caller's timeout instead of being refused.
- `slow(factor)` multiplies service time (capacity divides by it); `degraded(capacity)` multiplies capacity.
- `failover` loses one primary of a store with primaries: writes to that shard fail, reads continue on replicas if there are any, and managed stores fail over transparently.

Faults on ingress components (a crashed service instance) reduce capacity or reject requests before the handler runs.

Replication: writes to self-managed stores with a primary and replicas wait for them under semi-synchronous replication (one cross-zone round trip, 1 ms) or synchronous replication (2 ms), from the decision the workload names. Asynchronous replication adds no latency and is assumed until the candidate decides; what it risks is checked by `no-acknowledged-data-loss`.

### 8. Availability

The availability of operation `o` in an environment is the probability mass of its paths that end in a success status, after error propagation:

```
A_o = Σ_{p: status(p) ∈ success(o)} π(p)
```

Success statuses are declared per operation: `302` and `410`/`404` count as *correct* answers for redirect, while `5xx` does not.

### 9. Cost

Monthly cost has three parts:

- **instances**: `Σ shards × replicas × size.costPerHour × 730`;
- **storage**: GB-month for durable stores, `(stored entities × entity bytes) × copies × price`. The stored-entity counts come from the workload's `dataset`. Every replica of a shard holds a full copy, so read replicas are expensive at this data size. For URL Shortener, one copy of 158 B links is ~79 TB, so read replicas cannot be the main way to absorb 300,000 reads per second.
- **requests and egress**: for request-priced flavors (on-demand key-value DB, CDN later), from loads × seconds per month × price per million. This assumes the environment's traffic is sustained for the whole month. Budgets are therefore checked against the average environment, and peak-environment costs are a ceiling.

Prices are order-of-magnitude list prices with a stated date and source. They are used for **relative** comparison and budget checks with ±25% tolerance, never as quotes.

### 10. Collision and keyspace analysis

- **Random codes.** At horizon `H` years with `W` creates per second, the occupancy is `N = W · H · 3.15e7`. The conflict probability per insert is ≈ `N / K`, and the expected attempts per create are `1 / (1 − N/K)`. Both feed the conflict outcome and the write load.
- **Counter ranges.** Lease size and lease rate determine coordination load. Leases lost on crash only waste keyspace; the engine reports the fraction wasted.

**As built (M3).** The workload declares the stored dataset (158 B links at 5 years) and a keyspace per entity: an alphabet (62) and the decision point that sets the code length. Occupancy is `min(1, stored / alphabet^length)`; with no decision yet, the decision's default (7) applies. A conditional insert conflicts according to where its key came from, found by walking the path back to the most recent step that produced a key:

| Key origin | Conflict probability |
|---|---|
| a custom alias (`hasCustomAlias: custom`) | 1 for the "alias taken" request class, else 0 |
| `generateRandomCode`, `hashUrl` or `rehashWithSalt` | occupancy |
| `hashUrl` again after its code collided | 1 (the same URL hashes to the same code) |
| `ids.allocate` or `coord.leaseRange` | the share of the keyspace held by custom aliases |

Generated keys are unique among themselves, but a custom alias may already hold the code a key generator hands out, so the insert stays conditional. Alias occupancy is occupancy × the share of stored links that are custom aliases (about 1.9% in S1). That assumes every alias is as long as a generated code, an upper bound.

Retries are explicit steps, so a flow with *r* retries fails a share `occupancy^(r+1)` of generated creates. At 7 characters (occupancy ≈ 4.5%) one retry still fails about 0.2% of creates, which misses the 99.9% target; two retries or 8 characters meet it. At 6 characters the keyspace is smaller than the dataset and every generated insert collides.

Batched allocation (`batchSize`) calls the allocator once per batch:

- Load and connection rate are divided by the batch size.
- Only the refilling call can be rejected, so an overloaded allocator fails a share `drop / batchSize` of requests, not `drop`.
- Latency is a Bernoulli mixture: one request in a batch pays the full round trip and the others pay nothing. The mixture's mean and variance are exact, but the Gamma fitted to them is unimodal, so tail percentiles for rare expensive calls are approximate.

Lease waste on crash is not modelled yet.

---

## Discrete-event engine (phase 2)

Used when **time** matters:

- a cache restart produces a cold cache, a miss storm, and possibly a thundering herd on the hottest keys;
- retries synchronise without jitter;
- autoscaling reacts with provisioning delay during a spike;
- circuit breakers open and close;
- failover timelines run (detection → promotion → client reconnection).

Design:

- **Requests.** Sampled from the operation mix and the Zipf key distribution, with a Poisson process or a shaped profile (ramp, spike, step). Each request walks its flow step by step.
- **Components.** `c`-server queues with service-time distributions from the catalog. Bounded queues reject when full.
- **Real keyed cache.** LRU with TTL and request coalescing (single-flight) as a configurable behaviour. This makes stampedes and coalescing visible.
- **Timeouts.** Scheduled cancellation events.
- **Retries.** Backoff and jitter as configured.
- **Circuit breakers.** A state machine (closed, open, half-open) with a sliding window.
- **Autoscaler.** Metric window, scale-out threshold, provisioning delay.
- **Scaled simulation.** At 300 k RPS, simulating every request is wasteful. The engine simulates a sampled fraction `f` of requests, scales capacities by `f`, and keeps the key population exact. Utilisation and latency are preserved. Absolute cache behaviour is preserved because the key distribution is unchanged. Documented limits apply.
- **PRNG.** xoshiro128** seeded per scenario, so the same seed gives the same timeline.
- **Outputs.** Per-second series (RPS, p50/p99, error rate, hit ratio, per-component utilisation), up to ~600 sampled request traces, and an event log (fault start, breaker open, scale-out, …).

The analytic and DES engines must agree in steady state. A CI test runs both on reference designs and asserts that utilisation and p50 agree within tolerance.

---

## Validation of the simulation itself

| Test | What it proves |
|---|---|
| M/M/1 and M/M/c against closed-form or published Erlang-C values | The queueing model is exact where it is used, and the approximation's error band is stated |
| Che approximation against the DES with a real LRU | The cache model is calibrated |
| Property tests | Adding capacity never increases latency or error rate. Adding a handled fallback never lowers availability. Removing jitter or bounds never improves stability. |
| Determinism tests | Identical inputs give byte-identical metrics |
| Golden numbers per reference design | Unintended changes to engine behaviour are caught and reviewed |

## Stated limitations

These are shown in the UI's "About the model" panel:

- Numbers are ballparks for comparing designs, not capacity planning.
- Network effects beyond hop latency are not modelled: bandwidth saturation is approximated, and TCP is not modelled.
- The analytic engine assumes steady state. Transients need the DES.
- Garbage-collection pauses, noisy neighbours, and JVM warm-up are folded into each catalog entry's coefficient of variation.
