# 04 — Simulation

The simulation turns a design plus a scenario environment into **metrics**: load, utilisation, latency percentiles, error rates, hit ratios, availability, and cost. Metric checks consume these numbers.

There are two engines:

| Engine | Phase | Use | Speed |
|---|---|---|---|
| **Analytic** (steady state) | v0.1 | Every scenario, every edit | < 50 ms typical |
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

### 1. Outcome probabilities

Each outcome probability comes from the scenario, never from the candidate.

| Outcome | Source |
|---|---|
| `cache.get = hit` | cache model (below), from key popularity, capacity, TTL, and shard state |
| `store.read = found` | `1 − notFoundShare` (workload) |
| `checkExpiry = expired` | `expiredShare` (workload) |
| `insertIfAbsent = conflict` | for random codes: occupancy `N / K` at the scenario horizon (`N` links, `K` keyspace); custom aliases: `aliasConflictShare` |
| `validateUrl = invalid` | `invalidShare` (workload) |
| `*.error` | fault state of the target, plus overload drops, plus the timeout fraction (sections 5–6) |

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

**Negative caching** applies the same model to not-found keys with their own TTL.

**Near cache (two-tier).** A small in-process cache with its own capacity per service replica and its own TTL sits in front. Its misses feed the shared cache.

**Hot keys and shards.** Keys hash to shards. The load on the hottest shard is approximately

```
λ_cache · (q_1 + (1 − q_1) / S)
```

where `S` is the shard count and `q_1` the hottest key's share. Viral-spike workloads can override `q_1` directly, for example "one link takes 30% of traffic". `utilization-below` uses the per-shard value. This is what makes the hot-key problem show up.

### 4. Capacity, utilisation, and queueing latency

- **Capacity.** A component with `c` replicas (or shards × replicas) and per-replica capacity `μ` (by operation class) has utilisation `ρ = L / (c · μ)`. For autoscaling services, `c` is the smallest count in `[min, max]` that keeps `ρ ≤ targetUtilization`. In the analytic engine, autoscaling is instantaneous; the lag is a DES topic.
- **Mean service time.** `S` is the catalog base latency for the size preset.
- **Waiting time.** For `ρ < 1`, Sakasegawa's approximation for M/M/c gives

  ```
  W_q ≈ ρ^(√(2(c+1)) − 1) / (c · (1 − ρ)) · S
  ```

  Utilisation is capped at 0.98 inside the formula. Overload is handled separately (section 6). Unit tests compare the approximation against exact Erlang-C results.
- **Node latency** is modelled as a shifted distribution: fixed part `S`, plus a variable part with mean `W_q + cv·S` and variance derived from the catalog coefficient of variation.
- **Network hops.** Each connection adds hop latency based on placement: same zone ~0.3 ms, cross-zone ~1 ms, cross-region from a region matrix.

### 5. Path latency and percentiles

- **Per path.** Path latency is the sum of its hop and node latencies. Means and variances add, and the path is moment-matched to a **shifted Gamma** distribution.
- **Per operation.** Operation latency is the **mixture** over paths weighted by `π(p)`. p50, p95, and p99 are found by bisection on the mixture CDF.
- **Mixture, not maximum.** A cache hit and a cache miss are different distributions, and the p99 is often decided by the miss path. Taking the longest path instead would hide this.

### 6. Overload, timeouts, retries: the fixed point

Loads depend on error rates (retries add attempts, fallbacks shift load). Error rates depend on loads (overload, timeouts). The engine iterates:

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

### 8. Availability

The availability of operation `o` in an environment is the probability mass of its paths that end in a success status, after error propagation:

```
A_o = Σ_{p: status(p) ∈ success(o)} π(p)
```

Success statuses are declared per operation: `302` and `410`/`404` count as *correct* answers for redirect, while `5xx` does not.

### 9. Cost

Monthly cost has three parts:

- **instances**: `Σ replicas × size.costPerHour × 730`;
- **storage**: GB-month for durable stores, from entity size × retention × the replication factor;
- **requests and egress**: for request-priced flavors (on-demand key-value DB, CDN), from loads.

Prices are order-of-magnitude list prices with a stated date and source. They are used for **relative** comparison and budget checks with ±25% tolerance, never as quotes.

### 10. Collision and keyspace analysis

- **Random codes.** At horizon `H` years with `W` creates per second, the occupancy is `N = W · H · 3.15e7`. The conflict probability per insert is ≈ `N / K`, and the expected attempts per create are `1 / (1 − N/K)`. Both feed the conflict outcome and the write load.
- **Counter ranges.** Lease size and lease rate determine coordination load. Leases lost on crash only waste keyspace; the engine reports the fraction wasted.

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
| M/M/1 and M/M/c against closed-form or Erlang-C values | The queueing approximations are within a stated error band |
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
