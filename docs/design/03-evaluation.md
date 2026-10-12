# 03 — Evaluation engine

The evaluator answers one question per scenario: *does this design, under this scenario's workload and faults, behave the way the requirements demand?* It must accept every technically valid design and reject every broken one, and it must say why.

## Pipeline

```
Attempt + Problem + Scenario
        │
        ▼
1. Validate      schema, references, connection/action compatibility, unhandled outcomes
        │        (blocking errors stop here, each with an exact location)
        ▼
2. Analyse       path enumeration (symbolic execution of flows), dataflow facts,
        │        topology facts, configuration facts            → Facts
        ▼
3. Simulate      analytic model per scenario environment        → Metrics
        │        (DES for timeline scenarios, phase 2)
        ▼
4. Check         check library over Facts + Metrics + Decisions → CheckResults
        ▼
5. Recognise     strategy registry over Facts                   → Strategies
        ▼
6. Score         gates → dimensions → scenario score, plus signals
        ▼
7. Explain       findings with evidence, remediation, interview framing
```

Every stage is a pure function. Stages 2–7 are memoised on the hash of their inputs, so a configuration change that does not alter paths skips path enumeration.

---

## Stage 2: Analysis

### Path enumeration (symbolic execution)

For each operation, the flow DAG is expanded into **paths**: sequences of steps from the root to a `respond` or `fail`, with one outcome chosen at every branch. Flows are small (typically under 30 steps and under 50 paths), so exhaustive enumeration is cheap. A hard cap of 2,000 paths per operation, with a validation error beyond it, guards against pathological graphs.

Each path records:

- the ingress route, the steps, and the outcome taken at each step;
- the terminal status (`302`, `404`, `503`, …);
- the symbolic condition, for example `cache.get=miss ∧ store.read=found ∧ checkExpiry=valid`;
- per-component visit counts, used by the simulation;
- dataflow effects: reads, writes, conditional writes, cache populations and invalidations, publishes, together with their order.

### Facts

Checks query **facts**, never raw React Flow nodes. Facts are derived once per evaluation.

| Fact family | Examples |
|---|---|
| Path facts | `paths(op)`, `pathsEndingIn(op, 2xx)`, `stepsOn(path)`, `before(path, a, b)` |
| Dataflow facts | `durableWritesOf(entity, path)`, `readSource(entity, path)`, `populatesAfterMiss(cache, entity)`, `invalidations(entity, op)`, `atomicUniquenessPrimitive(entity, op)` |
| Topology facts | `componentsOnPaths(op)`, `singlePointsOfFailure(op)`: components on every successful path with no redundancy, `zonesSpanned(component)`, `unusedComponents()` |
| Config facts | `ttl(cache, entity)`, `timeoutChain(path)`, `retryPolicy(connection)`, `replicationMode(store)`, `healthCheckDetectionSec(lb)` |
| Capability facts | `capabilities(component)`, adjusted by configuration |

Facts carry **evidence handles**: component, connection, step, and path IDs. Every finding can then highlight exactly what caused it.

---

## Stage 4: The check library

A check is a pure function:

```
check(params, facts, metrics, decisions) → { status: pass | partial | fail | n/a, fraction: 0..1, evidence[], messageKey, data }
```

Checks are written in TypeScript in `packages/evaluator`, are parameterised from YAML, and are unit-tested with fixtures. Each check declares:

- `dimension`: correctness, consistency, durability, latency, scalability, availability, cache-efficiency, cost, security, or operability;
- `requirements[]`, for traceability;
- `severity`: critical, major, or minor;
- `signal`: baseline, senior, or staff;
- `applicability`: when the check is `n/a`. For example, invalidation checks are `n/a` if the design has no cache.

### Families and representative checks

**Path and outcome checks**
- `outcome-handled(op, capability, outcome)`: every step of that capability handles the outcome.
- `all-success-paths-contain(op, actionPattern)`: every 2xx/3xx path includes a matching step.
- `no-path(op, condition)`: for example, no path returns `302` without reading `Link` from a store that holds it.
- `status-for-condition(op, condition, status)`: for example, `checkExpiry=expired → 410|404`.

**Dataflow checks**
- `durable-write-before-ack(op, entity)`: on every path ending in `201`, a durable write of `entity` precedes the response. Writes to a durable log with `acks=all` and replication factor ≥ 3 count, with a consistency caveat (see `read-your-writes`).
- `atomic-uniqueness(op, entity, key)`: uniqueness is enforced by an atomic primitive (`insertIfAbsent`, a unique constraint, an atomic KGS claim, or a range lease). This check detects the **check-then-insert race**: `read → notFound → insert` without a conditional write.
- `conflict-handled(op)`: the `conflict` outcome leads to a bounded retry with a new code, or to `409` for custom aliases.
- `populate-after-miss(op, cache, entity)`: on miss → found paths the cache is populated with a TTL. Without population the cache never warms, and the simulation shows a hit ratio near zero.
- `ttl-respects-expiry(cache, entity)`: a cached entry cannot outlive the entity's `expiresAt`. Satisfied by an expiry check on the hit path, or by TTL = min(default, expiresAt − now).
- `invalidation-on-write(op, entity, maxStalenessSec)`: after an update or disable, staleness is bounded by the requirement. Valid strategies:
  1. delete the cache entry after the durable write;
  2. TTL ≤ budget;
  3. CDN purge when edge caching applies.
  Ordering matters: *delete-then-write* is flagged because of the stale-repopulation race.
- `read-your-writes(writeOp, readOp)`: a read issued right after a successful write observes it. This is violated by async persistence without cache priming, or by reads from async replicas without a fallback to the primary.
- `no-sync-write-on-read-path(op)`: for example, click counting must not be a synchronous database increment.

**Topology and resilience checks**
- `no-single-point-of-failure(op)`: every component on every success path has redundancy (replicas ≥ 2 or a managed multi-AZ flavor).
- `multi-zone(op)`: success paths survive the loss of one zone (staff signal).
- `dependency-timeout-bounded(capability, maxMs)`: the timeout to a dependency is short enough that its failure cannot consume the latency budget.
- `timeout-chain-consistent(op)`: along every path, an upstream timeout exceeds the worst-case downstream time, (retries + 1) × downstream timeout + backoff. An upstream that gives up first wastes downstream work.
- `retries-bounded-with-jitter(connection)`: no unbounded retries, exponential backoff, and jitter.
- `retry-only-idempotent(op)`: a non-idempotent write is retried only with an idempotency key.
- `circuit-breaker-on-dependency(capability)`: senior signal.
- `health-check-detection(lb, maxSec)`.

**Metric checks** (from the simulation, per environment)
- `p99-below(op, ms)`, `p50-below(op, ms)`.
- `error-rate-below(op, rate, environment)`.
- `utilization-below(selector, max, environment)`: for example, no shard above 0.8 at peak.
- `hit-ratio-above(cache, ratio)`.
- `no-cascading-failure(from, to, environment)`: a fault affecting `from` must not push `to` past its error budget. For example, a cache outage must not take down link creation through a shared, overloaded database.
- `no-acknowledged-data-loss(op, environment)`: on failover, writes acknowledged before replication are counted.
- `stable-under-retries(environment)`: the analytic fixed point converges, so there is no retry amplification spiral.
- `cost-within-budget(budget)`.

**Decision checks**
- `decision-consistent(decision, requirement)`: for example, `301` versus FR-4 revocation or per-click analytics.
- `decision-matches-design(decision)`: for example, a decision of `kgs` requires an `ids.allocate` step on the create path.

**Hygiene checks**
- `unused-components()`: components on no path of any operation count as complexity and cost, with no benefit.
- `overprovisioned(selector)`: peak utilisation below 10% with more than 2 replicas. Feedback only; affects the cost dimension.

---

## Stage 5: Strategy recognition

Requirements usually admit several valid designs. A **strategy** is a named, documented bundle of predicates over facts. Strategies are grouped per requirement. A requirement is satisfied if **any** strategy in its group is recognised, and the best-matching one is reported.

Example, `NFR-3` (unique, non-enumerable codes) for URL Shortener:

| Strategy | Recognised when | Extra checks activated | Notes in feedback |
|---|---|---|---|
| `kgs` | the create path has `ids.allocate` before the durable write | KGS redundancy; KGS keys from an atomically claimed pool; **custom aliases still need a conflict path**, because they share the namespace with pre-generated keys | "Pre-generated random keys: no collision checks at write time." |
| `random-conditional` | `logic(generateRandomCode)` then `insertIfAbsent`, with `conflict → retry` | retry bound ≥ 1; the simulation reports the collision rate at 5-year occupancy | "At 158 B links in a 62⁷ keyspace, about 4.5% of inserts collide by year 5. 8 characters cut that to about 0.07%." |
| `counter-range` | `coord.leaseRange` or a `snowflake` allocator, then `encodeBase62` | **non-enumerability** requires `logic(obfuscateId)` (a bijective shuffle such as a Feistel network); otherwise NFR-3 fails | "Collision-free by construction, but sequential codes are enumerable unless obfuscated." |
| `hash-based` | `logic(hashUrl)` then `insertIfAbsent`, with `conflict →` (same URL → return existing, different URL → salt and retry) | conflict branch distinguishes same-URL from different-URL | "Same URL maps to the same code. Decide whether per-user links matter." |
| *anti-pattern* `check-then-insert` | `store.read → notFound → store.insert` (unconditional) | forces `atomic-uniqueness` to fail (critical) | "Two concurrent creates can both see notFound and both insert. That is the classic TOCTOU race." |

### Unrecognised approaches

If no strategy matches but the outcome checks for that requirement pass, the requirement is marked **"satisfied — approach not recognised"**. It gets outcome-based credit, and the user is prompted to export the design for review. This turns false negatives into registry improvements instead of silent zeros.

---

## Stage 6: Scoring

1. **Gates.** Checks marked `gate: true` express non-negotiable correctness, for example "redirect returns the stored long URL" or "uniqueness is atomic". If any gate fails, the scenario status is **Not passing** and the score is capped at 40. A broken design can never look "decent".
2. **Dimension score.**

   `dimension = Σ(weight × fraction) / Σ(weight)`

   The sums run over the applicable **baseline** checks in that dimension. A check belongs to exactly one dimension, so there is no double counting.
3. **Scenario score.**

   `score = 100 × Σ(dimensionWeight × dimension)`

   The scenario defines the dimension weights.
4. **Severity caps.** Open baseline findings cap the score by their severity:
   - a **critical** finding caps the score at 79, so the band is at most Passing;
   - a **major** finding caps it at 89, so the band is at most Strong.

   This keeps "Excellent" honest. For example, a single API instance on a 99.99% read path cannot rank as excellent however good the rest is. Minor findings never cap. The scorecard reports which cap applied and why.
5. **Bands.**

   | Band | Score |
   |---|---|
   | Not passing | < 60, or any gate failed |
   | Passing | 60–79 |
   | Strong | 80–89 |
   | Excellent | ≥ 90 |

6. **Signals (depth).** Checks tagged `senior` or `staff` do **not** lower the score when missing. They appear as "signals demonstrated: 4 / 7 senior, 1 / 3 staff". Examples: negative caching, stampede protection, two-tier caching, idempotency keys, multi-zone survival, ID obfuscation, bounded-staleness reasoning. A correct baseline design is never penalised for not being clever, and depth stays visible.
7. **Problem summary.** A **scenario × dimension matrix** (heatmap), not a single number. Scenarios with regressions since they last passed are flagged.

Scores are only computed for **valid** attempts. Validation errors produce a "fix these to evaluate" state with locations, not a zero.

---

## Stage 7: Feedback

Every failing or partial check produces a finding with these fields:

| Field | Example |
|---|---|
| Title | "Cache miss does not populate the cache" |
| What we checked | "On redirect paths where `cache.get=miss` and `store.read=found`, a `cache.set` step should follow." |
| What we found | "Path `miss → found → 302` (9.4% of requests) returns without populating. The simulated hit ratio is 0.3%." |
| Evidence | step `read-db`, connection `link-api→redis`, path #3: highlighted on the canvas and in the path explorer |
| Why interviewers care | "Without population the cache never warms. The database serves almost all 300 k RPS at peak." |
| Fix | "Add `cache.set(Link, ttl)` after a successful read, with a TTL bounded by the link's expiry." |
| Requirement | NFR-1, NFR-2 |
| Learn more | concept card: cache-aside |

Findings are ordered by gate, then severity, then estimated impact (from the metrics delta). The panel also offers **what-if deltas** where cheap. For example: "Doubling cache memory raises the hit ratio from 0.81 to 0.86 and lowers database utilisation from 0.92 to 0.68."

---

## Reliability: how we keep false positives and negatives down

| Mechanism | Guards against | How |
|---|---|---|
| **Capability-based checks** | False negatives: valid technology choices rejected | Checks never name products. "Volatile KV" covers Redis, Memcached, Valkey, and near-caches. |
| **Strategy registry** | False negatives: valid alternative designs rejected | OR-groups of strategies per requirement, plus "approach not recognised" with outcome credit. |
| **Outcome checks from simulation** | False positives: designs that look right but don't work | A queue nobody consumes cannot improve p99. A cache that is never populated has a near-zero hit ratio. |
| **Gates** | False positives: broken designs scoring "decent" | Score cap at 40 if any gate fails. |
| **Unused-component and cost checks** | Buzzword designs | Components on no path add cost and complexity, never points. |
| **Golden corpus** (CI) | Regressions into false negatives | 6+ hand-built valid designs per problem, each with expected bands per scenario. |
| **Mutant corpus** (CI) | Regressions into false positives | Mutation operators are applied to golden designs. Each mutant must fail **the specific check(s)** listed in its expectation. Mutation score must be 100%. |
| **Property-based tests** (fast-check) | Scoring bugs | Scores stay within [0, 100]. Breaking a gate never raises a score. Adding a component on no path never raises a score. Results are deterministic. Removing a handled outcome never raises availability. |
| **Check unit tests** | Logic errors in individual checks | Fixture designs per check: pass, fail, and n/a cases. |

### Mutation operators (initial set)

1. Reverse a connection.
2. Delete a step and re-link its predecessor to its successor.
3. Re-route an outcome to `fail`.
4. Remove `cache.set` after a miss.
5. Replace `insertIfAbsent` with `insert`.
6. Remove the `conflict` branch.
7. Set replicas to 1 on a component on a success path.
8. Remove a cache TTL.
9. Remove the retry bound (`max: ∞`).
10. Remove retry jitter.
11. Change an async connection to sync.
12. Swap the durable store binding to a volatile one.
13. Move the response before the durable write.
14. Swap the order of the cache delete and the store update in an invalidation flow.
15. Raise a dependency timeout above the upstream timeout.
16. Change the redirect-status decision to `301` while FR-4 is present.
17. Remove the `obfuscateId` step from a counter-range design.
18. Drop the health-check config.
19. Route redirect reads to an async replica with no primary fallback.
20. Remove negative caching (expected: lose a signal, not a gate).
21. Add a disconnected component (expected: hygiene finding only).
22. Replace `ids.allocate` with `logic(generateRandomCode)` without changing the write (expected: the strategy changes and `atomic-uniqueness` fails).

Each mutant expectation is declared in the problem pack:

```yaml
- mutant: { base: golden/postgres-redis-kgs, op: replace-action, step: write-link, with: store.insert }
  expect: { scenario: s1-create, fails: [atomic-uniqueness], status: not-passing }
```

CI prints a mutation report. It is a portfolio artefact and the quickest way to see whether the evaluator can be trusted.
