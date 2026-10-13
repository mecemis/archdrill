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

### M2: Analytic simulation (L) ✅
- Load propagation.
- Cache model: Zipf buckets, Che approximation, TTL, negative caching.
- Queueing latency (Sakasegawa) and mixture percentiles.
- Cost model.
- Metrics panel; utilisation heat on the canvas; metric checks.
- S2 complete, then S3.
- Golden: 4. Mutants: 12.

**Done when:** changing cache memory or TTL visibly moves hit ratio → database utilisation → p99 → cost, and the S3 golden and mutant expectations hold.

**Delivered (2026-10-12):**
- The analytic engine: Zipf buckets, Che + TTL caches, exact Erlang C queueing, Gamma latency mixtures, an overload fixed point, request classes, and cost covering instances, requests and storage per copy.
- Five metric checks.
- A workload for S2 and the new scenario S3.
- Four golden designs and 17 mutants.
- In the editor: a Load tab, utilisation on nodes, rates on connections, path shares and p99, and shard sliders.

**Learned along the way:**
- **Storage cost.** Without storage cost, the budget could not tell caching from read-replica sprawl; with ~79 TB per copy it can.
- **The overload gate.** Without a 99% success gate at peak, a design that dropped half its traffic still scored "passing". Overloaded components also needed a queueing wait, or rejected traffic made p99 look good.
- **The simulator catches real sizing mistakes.** It flagged undersized tiers in our own golden designs (two NGINX instances for 300,000 requests a second).
- **Exact Erlang C instead of Sakasegawa.** The exact formula is cheap enough, so Sakasegawa is used only beyond 5,000 servers.
- **Evaluation stays on the main thread.** Two scenarios with two environments each take a few milliseconds, cached per attempt version, so the worker is deferred until the discrete-event engine needs it.

### M3: Write path and strategies (M) ✅
- Conditional writes, conflict outcomes, id-generation and leases capabilities.
- Strategy registry: kgs, random-conditional, counter-range, hash-based, and the check-then-insert anti-pattern.
- Decisions panel and decision checks.
- Collision analysis.
- S1.
- Golden: 5. Mutants: 18.

**Done when:** all four strategies are recognised in golden designs, and the check-then-insert race is caught as a gate failure.

**Delivered (2026-10-12):**
- Model: `ids.allocate` and `coord.leaseRange` with optional batch sizes, alias and code-generation logic, `store.insert` as an explicit overwriting put, decision defaults, and keyspaces sized by a decision.
- Engine: conflict probability by key origin (taken alias, random or hashed code at keyspace occupancy, allocated key never), and batched allocation.
- Evaluator: `recognize-strategy`, `ingress-has-capability`, the `hasSequence` predicate and the `batched` step matcher, `applicableWhen` for `no-path`, single points of failure judged per kind of request, and error causes in success-rate findings.
- Content: S1 with 5 gates, 13 baseline checks and 2 senior signals; API gateway, key generation service and coordination service kinds; the `code-length` decision.
- Corpus: five golden designs covering all four strategies (each scores 100 in S1), and 15 new mutants (32 in total).
- Web: a Decisions panel, the recognised approach in the score summary, batch sizes in the step form, and icons for the new kinds.

**Learned along the way:**
- **Counting inserts does not detect a retry.** When a retry's new allocation fails, the path has only one insert. The check now looks for a new code after a conflict, as an ordered step sequence.
- **Single points of failure depend on the kind of request.** Custom aliases bypass the key generator, so "some path survives without it" let a single KGS pass. Paths are now grouped by the outcomes of branching logic before asking whether a component is critical.
- **The code-length decision makes collisions concrete.** With 7 characters and one retry, about 0.2% of creates fail at 5-year occupancy, which misses the 99.9% target. The simulation shows the candidate why 8 characters or a second retry is needed.
- **Code review caught the simulation contradicting the scenario.** The S1 text said pre-generated keys can meet a custom alias, but the engine treated them as never colliding. Generated keys now collide at the share of the keyspace that aliases hold. The same review found that hashing the same URL again was simulated as a fresh draw; it now collides every time unless salted.
- **Visual QA still finds real bugs.** The flow panel claimed that no client could reach the handler whenever the design had validation errors, because it read the route from an analysis that is skipped for invalid designs.

### M4: Faults, timeouts, retries (L) ✅
- Fault model (crash, hang, slow, degraded, partition, failover; scopes).
- Fixed-point iteration with overload, timeouts, and retry amplification, plus divergence detection.
- Connection policies UI.
- Resilience and durability checks.
- S4 and S6.
- Golden: 6. Mutants: 25.

**Done when:** cache-cluster-down shows the miss storm and its mitigations; unbounded retries are flagged as unstable; acknowledged-write loss on async failover is detected.

**Delivered (2026-10-13):**
- Model: connection policies (timeout, retries with backoff and jitter, circuit breaker, bulkhead), environment faults selected by role, a replication decision in workloads, and actions that are unsafe to retry.
- Engine: faults (down, one node, one shard, hang, slow, degraded, failover), a per-call model of shedding, faults, overload and timeouts with retries and a breaker, replication latency, a warm start, and detection of metastable retry storms. The simulator is split into setup, the fixed-point loop and summaries.
- Evaluator: eight checks for timeouts, retries, idempotency, breakers, retry storms, acknowledged data loss, invalidation and decisions; workload validation for replication decisions.
- Content: S4 (cache outage and invalidation) and S6 (dependency failure); every design with a read path checks link status and invalidates on disable; the Postgres golden isolates redirects behind a bulkhead; a sixth golden sizes the database for losing the whole cache. 14 new mutants (46 in total).
- Web: a call-policy editor with live call metrics, environment descriptions and faults in the load view, a calls table, and fault badges on the canvas.
- Partitions and zone outages are left for later.

**Learned along the way:**
- **Breakers and bulkheads interact.** A breaker that counted the caller's own bulkhead rejections opened and starved the database; real breakers count failures from the dependency. A bulkhead is a hard limit, so its shedding is computed from the current call rate instead of being relaxed.
- **Discontinuities make the fixed point flap.** The queueing wait jumped to the overload wait at exactly 100% utilisation, so timeouts and breakers flipped between iterations. A ramp between 98% and 102% and shrinking damping fixed it.
- **The starting point is a shock.** Cold caches at the start pushed a design with ten unspaced retries into a lasting overload that the model reported as the healthy state. Starting warm, and solving a second time from cold, turned the artefact into a feature: the evaluator now reports metastable retry storms.
- **A hanging cache costs twice.** Lookups and populations both wait out the timeout; the first test assumed only one.
- **A property test found a real non-monotonicity.** With a broken miss branch, more cache capacity lowered success, because fewer requests errored into the working fallback. The property now holds on the intact flow only.
- **Successful calls come back before the timeout.** Their latency is the Gamma truncated at the timeout, not the unbounded one.
- **Code review found that retries "healed" partial faults.** Attempts were independent, so with one of four shards down and two retries a call failed 1.6% of the time instead of 25%. A fault now takes out keys for good. The same review split read and write capacity, which made the MySQL golden's failover headroom honest: it needed a third replica.

### M5: Scale and polish (M) ✅
- Shards and hot keys, near cache, autoscaling bounds.
- S5.
- Regression detection across scenarios; snapshot diff.
- Hints and debriefs.
- Export/import with migrations.

M5 was split: worker and consumer flows and S7 moved to M6, so each milestone stays reviewable.

**Delivered (2026-10-13):**
- Model: request classes for one hot key, environment overrides of class shares, in-process kinds (a near cache), autoscaling bounds, export/import with versioned migrations, and a summary of what changed between two designs.
- Engine: a hot key's load lands on the one shard that holds it (its calls see that shard's overload and queueing); near caches keep one copy per instance of their service; autoscaled services add instances in the fixed point and are billed as whole instances. The simulator is split further into a propagation pass and cache relaxation.
- Evaluator: the hottest shard counts in `utilization-below`; `overprovisioned` and `autoscaling-configured`; step matchers by target kind; in-process caches can only be kept fresh by TTL; layered caches count hits at every tier.
- Content: S5 (peak traffic and hot keys) with an average day and a viral spike; debriefs for every scenario; the Postgres golden adds a near cache, autoscaling and a rate-limiting gateway and scores 100 in all six scenarios; its fixed-fleet version stays as a seventh golden for the under-provisioning mutants; five new mutants (51 in total).
- Web: autoscaling in the inspector, running instances and hot shards on nodes and in the load view, regression warnings across scenarios, a Compare tab against a pinned baseline, debriefs, and export/import.
- Persistence stays in localStorage: designs are a few kilobytes, so IndexedDB would add complexity without benefit; saved and imported designs share the migrations.

**Learned along the way:**
- **A better golden made the mutants toothless.** Autoscaling and a near cache absorbed the under-provisioning and unreplicated-cache mutations they were built to catch. The fixed-fleet design is kept as its own golden, and those mutants test it.
- **Layered caches need their own hit ratio.** Averaging a near cache's and Redis's hit ratios by lookups halved the reported ratio; hits at every tier count against the outermost tier's lookups.
- **A capability selector hit the near cache.** "Every cache hangs" also hung the in-process cache inside the service; in-process components now fail only with their service, unless a fault names their kind.
- **One change can lower four scenarios at once.** Separate toasts filled the screen; one toast now lists them all.
- **Code review caught a hit ratio above 100% in disguise.** Dividing all caches' hits by the busiest cache's lookups is right for a near cache in front of Redis but adds up caches that serve different requests; the engine now counts each request once, as a hit if any tier answered.
- **An implicit grid column grows with its widest child.** A crowded header widened the whole page until the root grid got an explicit `minmax(0, 1fr)` column.

### M6: Async work and edge cases (M) ✅
- Queues and publish steps, worker and consumer flows, scheduled jobs.
- External calls (a URL safety scan) and asynchronous moderation feeding disable-link.
- Backlog and consumer lag in the simulation; at-least-once delivery and idempotent consumers.
- S7 (edge cases): expiry and purge, invalid input, unknown codes, malicious URLs, code reuse.

**Delivered (2026-10-13):**
- Model: operations are triggered by a request, an event or a schedule; problems define events; `queue.publish` and `external.check`; malicious request classes; routes by trigger (a consumer connects to a queue its event is published to); batches that collect items only in consumers and jobs.
- Engine: consumer rates and classes follow from published messages; failed messages are redelivered five times, then dead-lettered; consumers and jobs report backlog growth and lag instead of rejecting work; collected batches fail together, cost a little per extra item and wait to fill.
- Evaluator: `unsafe-content-stopped`, `backlog-stable`, decision-driven statuses, conditional decision checks, lag in `latency-below`, optional consumers.
- Content: a queue kind (managed queue, Kafka) and a URL-safety API with a quota; purge-expired and scan-link; FR-5 and a code-reuse decision; S7 with a scanner outage. Two goldens pass S7 differently (a worker that scans every new link, and a check before answering that fails open into a rescan); fifteen new mutants (66 in total).
- Web: operations show their trigger; consumers are marked optional and say where their messages come from; publish steps pick an event; batch sizes for collected batches appear only in consumers and jobs; final statuses in background flows read as "done" or "try again later"; the load view shows lag, backlog and redeliveries.

**Learned along the way:**
- **Building the test design through commands found a dropped field.** New steps lost their event until a consumer was built step by step in a test; every step parameter is now carried through.
- **The new check found a gap in the test design itself.** Only generated codes were published, so links with custom aliases went live unchecked; `unsafe-content-stopped` named exactly those paths.
- **A consumer that nobody publishes to is a design error.** The first "no scan" mutant came out invalid rather than failing the check; the mutant now drops the consumer too, which is how a design without a scan looks.
- **Correlated redelivery needs no extra state.** Treating a failing message as failing on every delivery puts five times the load on its path, which is the honest picture during an outage and keeps the fixed point unchanged.
- **Some valid answers wait for later milestones.** A store's own TTL deletion as the purge, and a transactional outbox instead of publishing after the insert, are listed with v0.3's patterns; S7's debrief asks about both.

### M7: Hardening and release (M) ✅
- Mutation report in CI.
- Property-test suites.
- Playwright E2E for the core loop.
- Performance budgets verified.
- Docs: "How scoring works", "About the model", authoring guide (draft).
- Serve the production build (planned as Cloudflare Pages; it now runs on a home machine over Tailscale, and a public host can come later).

**Delivered (2026-10-13):**

*Reports.*
- `pnpm report` writes the corpus report: every golden design's score per scenario, and the checks that catch each mutant (66 of 66).
- It also writes the evaluation-time budget.
- CI publishes both to the run summary and as artefacts.

*Success criteria as tests.*
- A design that wires every popular component in one chain, without using them, passes no scenario.
- Every finding across the corpus points at something and has a fix.
- Decision findings point at the decision, which the Decisions panel highlights.

*Property suites.*
- Background work: consumer rates, backlog bounds, batch load, and isolation of a failing consumer from its publishers.
- Export/import round trips, and check credit that matches the check's status.

*Browser tests.*
- Six Playwright tests run in CI. They cover:
  - building a read path;
  - a gate finding;
  - importing a golden design;
  - dropping and undoing S7's safety scan;
  - a consumer's redeliveries;
  - the production build under the production headers.

*Performance.*
- All scenarios on a 30-component design take about 50 ms (p50; it was 130 ms). The gains:
  - the cache warm-up stops when caches are warm;
  - the shock test is skipped when a cold start stays well below capacity;
  - call keys are precomputed, path probabilities no longer copy paths, and quantile bisection stops at a relative precision.
- Evaluation runs in a worker, with a fallback to the main thread.
- Libraries load as cached chunks.

*Docs.*
- How scoring works, About the model, and a draft authoring guide.

*Serving.*
- `pnpm serve` builds the app and serves the production build on `127.0.0.1:4173`, with a strict content security policy.
- A LaunchAgent keeps it running, and `tailscale serve` publishes it to the tailnet over HTTPS.
- The project is licensed MIT.

**Learned along the way:**
- **Profiling beat guessing.** Three hot spots that no one would have picked took most of the time: a string key built per call, a path copied per step, and 80-step bisections for every path's percentiles.
- **A test of the security policy found a crash.** Blocking the worker with the content security policy took the whole app down; the client now falls back to the main thread when a worker cannot start or fails.
- **A new hook after an early return slipped through review.** React reported it in the browser tests; Biome now rejects hooks called conditionally.
- **Every finding needs somewhere to point.** Decisions had no place on the canvas; they now have their own kind of evidence.

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

Back in the URL shortener, v0.3 also adds a store's own TTL deletion as an alternative to a purge job, a transactional outbox for `link-created`, and a check for idempotent consumers whose writes are not naturally idempotent (S8's counters).

Also in v0.3:
- A problem authoring guide and a JSON Schema for editors.
- Compare mode: two attempts against the same scenario script.

## v0.4 and later (only if justified)
- Shareable read-only links (static, encoded attempt).
- An optional backend (accounts, sync, community problem packs).
- Multi-region scenarios.
