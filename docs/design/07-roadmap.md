# 07 — Roadmap

## Strategy: vertical slices, not layers

The riskiest assumptions are these:

1. Recording flows feels fast, not like form-filling.
2. Path-based feedback is genuinely useful.
3. The evaluator can be trusted (golden and mutant corpora).

Each milestone therefore delivers a thin, end-to-end slice (model → engine → evaluator → UI → content). Building every layer in full before any UI exists would test none of these until too late.

Sizes: **S** ≈ a few days, **M** ≈ 1–2 weeks, **L** ≈ 2–3 weeks of focused part-time work.

---

## v0.1: URL Shortener in depth

### M0: Foundations (S) ✅
- Design docs and ADRs (this folder).
- pnpm workspace, TypeScript strict, Biome, Vitest, CI.
- A web shell that renders an empty React Flow canvas, proving the toolchain.

**Done when:** `pnpm check && pnpm test && pnpm build` pass locally and in CI.

### M1: Walking skeleton for the redirect path (L) ✅
- `model`:
  - schemas for catalog (6 kinds: client, load-balancer, service, cache, relational-db, key-value-db), architecture, connections, flows, scenarios, attempt;
  - reference validators;
  - commands with Immer patches.
- `engine`: path enumeration and dataflow facts. No simulation yet.
- `evaluator`:
  - 6 checks: `outcome-handled`, `no-path`, `status-for-condition`, `all-success-paths-contain`, `populate-after-miss`, `unused-components`;
  - gates, scoring, feedback with evidence.
- `content`: YAML compiler with Zod validation; URL Shortener S2 without metric checks.
- `web`:
  - topology editor (palette, connect, inspector for size and replicas);
  - flow recorder with the step tree;
  - findings panel with evidence highlighting;
  - path explorer (without metrics).
- Golden: 2 designs. Mutants: 5.

**Done when:** a user can build a redirect flow by clicking, see every path, and get gate and check feedback that points at the canvas. Reversed connections and missing branches are caught.

**Delivered (2026-10-12):**
- Seven checks: the six planned, plus `no-single-point-of-failure`, defined over survival paths.
- Two golden designs and eleven mutants, all caught.
- Two Playwright tests of the core loop.

**Learned along the way:**
- **Severity caps.** An open critical finding caps the score at 79; an open major finding caps it at 89. Without this, a single API instance still scored "excellent".
- **The `negativeHit` cache outcome.** It is only feasible once a reachable flow step stores negative entries. Without modelling it, a redirect of a tombstoned code went unnoticed.
- **Evaluation runs on the main thread for now.** Without simulation it takes well under a millisecond. It moves to a worker together with the analytic engine in M2.

### M2: Analytic simulation (L)
- Load propagation.
- Cache model: Zipf buckets, Che approximation, TTL, negative caching.
- Queueing latency (Sakasegawa) and mixture percentiles.
- Cost model.
- Metrics panel; utilisation heat on the canvas; metric checks.
- S2 complete, then S3.
- Golden: 4. Mutants: 12.

**Done when:** changing cache memory or TTL visibly moves hit ratio → database utilisation → p99 → cost, and the S3 golden and mutant expectations hold.

### M3: Write path and strategies (M)
- Conditional writes, conflict outcomes, id-generation and leases capabilities.
- Strategy registry: kgs, random-conditional, counter-range, hash-based, and the check-then-insert anti-pattern.
- Decisions panel and decision checks.
- Collision analysis.
- S1.
- Golden: 5. Mutants: 18.

**Done when:** all four strategies are recognised in golden designs, and the check-then-insert race is caught as a gate failure.

### M4: Faults, timeouts, retries (L)
- Fault model (crash, hang, slow, degraded, partition, failover; scopes).
- Fixed-point iteration with overload, timeouts, and retry amplification, plus divergence detection.
- Connection policies UI.
- Resilience and durability checks.
- S4 and S6.
- Golden: 6. Mutants: 25.

**Done when:** cache-cluster-down shows the miss storm and its mitigations; unbounded retries are flagged as unstable; acknowledged-write loss on async failover is detected.

### M5: Scale, edges, polish (M)
- Shards and hot keys, near cache, autoscaling bounds.
- Worker and consumer flows.
- S5 and S7.
- Regression detection across scenarios; snapshot diff.
- Hints and debriefs.
- IndexedDB persistence; export/import with migrations.

### M6: Hardening and release (M)
- Mutation report in CI.
- Property-test suites.
- Playwright E2E for the core loop.
- Performance budgets verified.
- Docs: "How scoring works", "About the model", authoring guide (draft).
- Deploy to Cloudflare Pages.

**v0.1 is done when** every success criterion in [01-product.md](01-product.md#success-criteria) holds.

---

## v0.2: Time and failure dynamics
- Discrete-event engine in a worker: seeded, scaled, with traces.
- Timeline UI: fault events, per-second charts, request trace explorer.
- Cold cache and stampede, request coalescing, retry storms without jitter, autoscaling lag, failover timeline.
- S8 click analytics (logs, stream aggregation).
- Predict-then-reveal.
- Estimation gym (back-of-envelope checks with tolerance bands).

## v0.3: Pattern breadth

New problems are chosen to cover *different* patterns, not more of the same.

| Problem | Patterns |
|---|---|
| Distributed rate limiter | counters, consistency vs accuracy, sliding windows, multi-region |
| News feed | fan-out on write vs read, celebrity accounts, ranking pipeline, pagination |
| Chat / notifications | websockets, ordering, delivery semantics, presence, offline delivery |
| Order and payment processing | idempotency, outbox, sagas, exactly-once effects, reconciliation |

Also in v0.3:
- A problem authoring guide and a JSON Schema for editors.
- Compare mode: two attempts against the same scenario script.

## v0.4 and later (only if justified)
- Shareable read-only links (static, encoded attempt).
- An optional backend (accounts, sync, community problem packs).
- Multi-region scenarios.
