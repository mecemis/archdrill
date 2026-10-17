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

The original plan was a sampled per-request discrete-event engine. [ADR 0008](../adr/0008-time-stepped-timelines-instead-of-per-request-des.md) replaces it with time-stepped timelines built on the analytic engine: deterministic, fast, and in agreement with the steady state by construction.

### M8: Timeline engine (L) ✅
- Scenarios can define timelines: a duration, load shapes (steps, ramps, spikes) and timed events (faults that start and end).
- The engine advances in steps. In each step it re-solves loads, overload, timeouts and latency, warm-started from the previous step, and records per-step series: rate, success, p50 and p99 per operation; utilisation and instances per component; hit ratio per cache; backlog per consumer; an event log.
- Constant load without events settles on the analytic steady state (tested). Runs are deterministic, and a two-minute timeline stays well within budget.
- A first timeline view, and timeline checks (a metric within bounds over a window; recovery within a time after an event).

**Delivered (2026-10-13):**
- **Model.** Workloads define timelines: a duration, a step, starting rates, and `load` and `fault` events. Validation catches unknown operations, rates set for consumers, and events outside the timeline.
- **Engine.** `simulateTimeline` re-solves the fixed point at every step from the previous step's state. The fixed point now lives in its own module, shared with steady-state environments.
  - Each step records series per operation, component and cache, and marks faults, load changes and components crossing capacity.
  - Unchanged steps repeat the previous results: S6's two-minute timeline adds about 8 ms to an evaluation.
- **Evaluator.** `timeline-holds` and `timeline-recovers` run against the timelines, which every evaluation now simulates.
- **Content.** S6 gets `failover-over-time`. The replica-less database mutant now also fails the timeline check.
- **Web.** A Timeline tab with charts that need no chart library:
  - success rate, p99, utilisation, cache hit ratio and backlog;
  - fault windows shaded, and lines told apart by dash pattern as well as colour;
  - an event log.

**Learned along the way:**
- **The planned engine did not fit the problem.** A sampled per-request engine would have needed capacities scaled down to about one server per store at S2's peak, which changes the queueing it exists to show. Re-solving the analytic model per step keeps the queueing exact; ADR 0008 records the trade-off.
- **Most steps change nothing.** The first version summarised every step and added 40 ms to an evaluation. Repeating results for steps whose inputs and state did not move cut it to 8 ms.

### M9: Transient dynamics (L) ✅
- Cold caches after a flush or restart warm up over time; thundering herds on hot keys; request coalescing (single-flight) as a design choice.
- Autoscaling with a metric window, provisioning delay and cooldown.
- Circuit breakers as state machines: window, threshold, open time, half-open probes.
- Retries spread over time by backoff and jitter; failovers with detection, promotion and reconnection; backlogs that build and drain.
- Timeline variants of S4 (cache restart), S5 (spike with autoscaling lag) and S6 (failover), with goldens and mutants.

**Delivered (2026-10-13):**
- **Engine.**
  - Restarted caches fill up over time (time-dependent Che), with herds that coalesced reads avoid.
  - Autoscalers average utilisation over 30 s and wait for start-up times.
  - Breakers stay open for their wait.
  - Backlogs build and drain.
  - Ramps can be exponential.
- **Speed.** Che's characteristic time is computed once per cache, Erlang C is memoised, and later steps solve to 1e-5. A dynamic step costs about 0.7 ms.
- **Content.** Three new timelines, each with its own lesson:
  - S4 `cache-restart`: a bulkhead sized for a warm cache sheds for minutes;
  - S5 `viral-surge`: scaling at 80% falls behind a ten-minute surge;
  - S7 `bulk-import`: unbatched scans stay overloaded by their own redeliveries.
  The fixed-fleet golden's bulkhead and the Postgres golden's scans were adjusted, three mutants were added (69 in total), and the short-TTL mutant now uses 10 s.
- **Web.** A single-flight option on store reads, a running-instances chart, autoscaling timing in the inspector, and event-log lines for restarts, scaling and breakers.
- **Budgets.** The performance report separates analytic evaluation (p95 55 ms) from evaluation with timelines (p95 390 ms; budget 2 s).
- **Failover phases.** These are written as successive fault events (hanging, then refusing) rather than a dedicated event.

**Learned along the way:**
- **Timelines found a metastable failure no steady state shows.** After a burst, the redeliveries of failed scans kept the URL-safety API over its quota indefinitely. The healthy steady state still exists, but the system cannot get back to it on its own.
- **A golden design can be wrong in a way only time shows.** The fixed-fleet bulkhead was fine at a warm cache's hit ratio and shed redirects for minutes after a restart. Widening it then let a 30-second TTL fit too, so that mutant moved to 10 s to keep its lesson.
- **Linear ramps are a poor model of a spreading link.** A linear ramp grows fastest relative to load at its start, where no autoscaler can follow. An exponential one tests the real constraint: growth during the minute an instance takes to start.
- **The call model had a shortcut for healthy calls.** It skipped the breaker, so a breaker held open over a recovered dependency failed nothing until the shortcut learned about it.

### M10: Timeline UI (M) ✅
- Charts with event markers, and a scrubber that shows the canvas at a moment in time.
- A request trace explorer: example requests sampled from each step, with step-by-step timings.
- Predict, then reveal: before a timeline runs, the candidate can predict what will happen, and sees the prediction next to the result.

**Delivered (2026-10-13):**
- **Engine.** Each step records component latency and active faults, connection traffic, and the path mix of every operation. Timelines can carry predictions, which the engine answers from the series it records.
- **Content.** S4, S5, S6 and S7 each ask two questions before their timeline is shown, about peak load, the lowest success rate, or time to recover.
- **Web.**
  - The results dock enlarges for timelines.
  - Predict, then reveal, with answers kept per timeline.
  - A scrubber, with click-to-jump on charts and events, and a cursor with values on every chart.
  - The canvas at the picked moment.
  - The path mix at that moment.
- **Tests.** Engine tests for predictions and the new series, and a corpus test that every question gets at least two different answers across the goldens and the scenario's mutants. Unit tests cover the canvas snapshot and stored predictions, and browser tests cover predicting and picking a moment.

**Learned along the way:**
- **A path mix teaches more than sampled traces.** The plan was to sample example requests from each step. The engine already knows every path's exact share and latency at every step, so the timeline shows those instead, deterministic and complete, including the rare paths a sample would miss. Each path expands to per-call timings, which is what a trace would have shown.
- **A snapshot needs a stable identity.** The canvas re-projects whenever its load changes, and the first version built a new snapshot on every render, which looped. Each moment now builds its snapshot once.
- **Predictions need bounds that separate designs.** A question is only worth asking if designs answer it differently. Running every question against the corpus showed a wide spread, for example S4's store load ranges from calm (DynamoDB) to overloaded (MySQL with Memcached, and the retry storm). It also caught a bound in the wrong place: most designs lose 49.8% of creates during S6's failover, right at a 50% bound. The options now sit away from where designs land.

### M11: Click analytics and the estimation gym (L) ✅
- S8 click analytics: logs and streams, stream aggregation, counters that stay fresh within a minute, hot counters, and idempotent consumers whose writes are not naturally idempotent.
- Estimation gym: back-of-envelope questions per problem, with tolerance bands.

**Delivered (2026-10-13):**
- **Model and catalog.**
  - An `increment` action, and aggregation windows on increments and totals.
  - Counter shards, fire-and-forget publishes with a buffer, and batches where nothing waits for them.
  - Cassandra, a Flink stream processor that only takes messages, and DynamoDB's per-item write limit.
  - Counters live in durable stores only.
- **Engine.**
  - Distinct keys per window under Zipf popularity.
  - Lossy publishes that add no latency.
  - Per-key throttling of the hot key alone, and hotness only for rows keyed like the request.
  - Per-request pricing billed per item.
- **Evaluator.** `no-sync-write-on-read-path`, `publishes-without-waiting`, `event-consumed` and `idempotent-consumer-writes`.
- **S8.**
  - Peak, a hanging click queue and a viral link.
  - Two gates, ten scored checks, and senior and staff signals.
  - The Postgres golden counts clicks with Kafka, Flink and Cassandra and passes all eight scenarios.
  - Ten mutants (79 in all).
- **Estimation gym.**
  - Nine questions, answered as on a whiteboard and judged spot on, close or off.
  - Answers are kept in the design.
  - The brief's derived numbers wait until the estimates are answered.
- **Web.** A settings editor for call steps (windows, batches, shards, fire-and-forget, TTL, single-flight), which earlier steps could not change after they were added.
- **Speed.** Analytic evaluation with the analytics pipeline in every scenario stays at p95 78 ms.

**Learned along the way:**
- **Aggregation helps less than intuition says.** At 300,000 clicks a second, 10-second windows still write 37% as many rows as clicks, because most links in a window are clicked once. What aggregation does collapse is the hot key, to one write per window. That makes batching the writes, not just windowing them, what keeps the store small.
- **One shared design carries every feature into every scenario.** Once redirects publish clicks, S5's spike of a million redirects a second is also a million clicks a second. The click log needed producer batching and eight brokers before S5 passed again, and the average-day budget had to absorb the pipeline.
- **Batching must not discount per-request prices.** A batch costs one call in load, but DynamoDB bills every item. The first version billed calls, which made per-click counting in DynamoDB look cheap.
- **An optional consumer needs a gate when it is the point.** Consumers are optional in general (S7 can scan synchronously), so a design that published clicks and never counted them still scored 60. `event-consumed` makes counting required where the scenario is about counting.
- **The analytic budget is shared.** The first S8 build took analytic p95 from 55 to 91 ms. Two lookups in the hottest loop (an action table per step, a set per step) brought it back to 78 ms.

**v0.2 is done** when timelines and S8 hold to the same standard as v0.1: goldens pass, mutants are caught, and evaluation stays within its budgets.

## v0.3: Pattern breadth

New problems are chosen to cover *different* patterns, not more of the same.

Milestones:
- **M12: Problem packs.** Facts that decide logic and calls (no more URL-specific flags in the engine), the logic each problem offers, a problem picker, and JSON Schemas for editors. ✅ Delivered.
- **M13: Distributed rate limiter.** Shared counters on the request path, window algorithms, failing open or closed, a hot abusive client. ✅ Delivered: three scenarios, two goldens, eleven mutants, five estimates. It came with `service.call`, ephemeral and fact-bound entities, the hot key's dependence on writes that land, and a starting client per problem ([problem design](../problems/rate-limiter.md)).
- **M14: News feed.** Fan-out on write or read, celebrity accounts, timelines in a cache, pagination. ✅ Delivered: three scenarios, two goldens, ten mutants and five estimates. It came with fan-out steps (`each`) sized by per-class counts, batches of a request's own calls, all-hit lookups, and entities hot by fact ([problem design](../problems/news-feed.md)).
- **M15: Chat and notifications.** Connections as a resource, ordering, delivery and deduplication, presence, offline delivery. ✅ Delivered: three scenarios, two goldens, ten mutants and five estimates. It came with held connections and connection capacity, `connection.push`, `external.notify` with a push provider, connection servers, Cassandra's conditional writes, and problems that offer no logic ([problem design](../problems/chat.md)).
- **M16: Orders and payments.** Idempotency keys, a transactional outbox, sagas with compensation, reconciliation. ✅ Delivered: three scenarios, two goldens, ten mutants and four estimates. It came with a card payments provider, `external.charge`, `external.refund` and `payments.lookup`, idempotency keys, outbox publishes with their validation, `no-dual-write`, duplicate requests, and optional workload keys ([problem design](../problems/payments.md)).
- **M17: Back to the URL shortener, and compare mode.** Store TTLs instead of a purge job, an outbox for `link-created`, exactly-once counting, and two designs side by side. ✅ Delivered: `expired-data-removed` and optional scenario operations, TTLs on durable writes, `exactlyOnce` commits from stream processors, the DynamoDB golden on TTLs and the PostgreSQL golden on an outbox, and a Compare tab that loads a second design from a file and compares scores and costs in every scenario.

**v0.3 is done**:
- five problem packs (URL shortener, rate limiter, news feed, chat, payments), each with goldens and mutants held by CI;
- editor schemas for every content file;
- compare mode.

**Learned along the way (v0.3):**
- **Facts beat flags.** Moving URL-specific flags out of the engine into facts that logic and calls name took one milestone. After that, every new problem needed only the engine features its lesson called for: fan-outs, connections, outboxes.
- **Every new mechanism found a modelling gap.** A short-TTL block marker exposed that cache entries need writes that land, while long TTLs persist through a fault. Fan-outs needed per-class latency. Batched writes needed per-item billing.
- **Content tests catch content mistakes early.** Probing every golden in every scenario before writing mutants exposed several problems: thresholds a scraper could not cross, budgets the shared design blew, and checks that flagged legitimate fallback paths.
- **The analytic budget needs watching.** Each milestone added a few percent to the hottest loop, and calls across modules in that loop cost more than expected under the test runner. By M16 the CI runner sat at its budget.
  - Paths come from a depth-first walk and share the step objects of a common prefix, so each prefix's probability is now computed once per class.
  - That took analytic p50 from 92 to 66 ms and timelines from 530 to 390 ms, with identical results.

| Problem | Patterns |
|---|---|
| Distributed rate limiter | counters, consistency vs accuracy, sliding windows, multi-region |
| News feed | fan-out on write vs read, celebrity accounts, ranking pipeline, pagination |
| Chat / notifications | websockets, ordering, delivery semantics, presence, offline delivery |
| Order and payment processing | idempotency, outbox, sagas, exactly-once effects, reconciliation |

Back in the URL shortener, v0.3 also adds a store's own TTL deletion as an alternative to a purge job, a transactional outbox for `link-created`, and exactly-once processing (checkpointed state with transactional writes) as a third way to count clicks once.

Also in v0.3:
- A problem authoring guide and a JSON Schema for editors.
- Compare mode: two attempts against the same scenario script.

## M18: Redesign and dark mode (as built)

The interface was rebuilt around the canvas. ✅ Delivered:

- a design system of semantic colour tokens with light and dark themes;
- an icon rail with collapsible side panels, and a results drawer with three sizes;
- scenario steps with status colours;
- a categorised, searchable palette;
- category-tinted nodes;
- a score ring;
- views that fit a loaded design.

Browser tests cover themes, panels and the drawer.

## M19: Resizable panels and a live canvas (as built)

✅ Delivered:
- side panels and the results drawer resize by mouse or keyboard, and the sizes are remembered;
- components show their health under the simulated load (amber close to capacity; red and pulsing when overloaded or failing);
- badges show the open findings about each component and open them on click;
- traffic moves along connections in proportion to their load;
- timelines play on the canvas.

Unlike a decorative animation, every cue comes from the simulation: the shown environment or timeline moment, and the scenario's findings.

## M20: Onboarding and simpler flows (as built)

✅ Delivered:
- a first-visit welcome;
- a self-ticking getting-started guide with spotlights;
- example designs in a help menu;
- one-click step suggestions under every open branch;
- automatic entity binding;
- answering all open errors at once.

A first scenario now takes a handful of clicks from an empty canvas to a score.

The flow editor was then rebuilt around a top-to-bottom list of steps in plain sentences. One searchable picker chooses each step, and outcomes that end a request get their conventional response, changeable in place. It replaces the indented tree and its per-branch forms.

## M21: A realism foundation

**Part 1, sources (as built).** Every catalog number is published (cited, with the date read) or a model (reasoning and basis), and each size names the real offering it stands for ([ADR 0009](../adr/0009-every-number-has-a-source.md)). Tests enforce the coverage, and the inspector shows it. Prices and memory now match their sources; no score in the corpus changed.

**Part 2, the URL-safety API (as built).** Web Risk as Google publishes it: the Lookup API at $0.50 per 1,000 calls and 6,000 calls a minute, and local threat lists from the Update API, where only matches are confirmed, at $50 per 1,000. A new decision matches a URL against the local copy; it needs the lists' provider connected, and a new check asks that matches are confirmed before acting. Batched checks are gone, since Web Risk has none. S7 now teaches why per-URL lookups cannot carry 1,000 links a second, and a new critical check catches a scanner that fails most of its scans. Both goldens still score 100, and all 81 URL-shortener mutants are caught (122 across the corpus).

**Part 3, push notifications (as built).** FCM's default quota (600,000 messages a minute) is published; the raised quota the chat pack uses (100,000 a second) is labelled an assumption. Every device counts against it, since the HTTP v1 API has no multicast, so `external.notify` lost its batch size. Chat S2's lesson changed from batching notifications to notifying a large group's members only when mentioned, with a new decision (`isLargeGroup`) and a critical check that direct messages and small groups still notify everyone. Step matchers can name a fan-out count (`each`). Card payments got the same treatment: Stripe's live-mode default (25 requests a second per endpoint) is published, and the payments pack's 5,000 is labelled a contract assumption.

**Part 4, calibration (as built).** Published benchmarks the engine replays with the catalog's numbers, run by run, within 15% ([ADR 0010](../adr/0010-calibrated-against-published-benchmarks.md)).
- **The replay.** Closed runs settle where throughput = clients ÷ (latency + round trip), with the engine's own queueing latency. Open runs give the median at a fixed rate.
- **The calibrations.**
  - pgbench select-only on 2 vCPUs, replayed at a sixth of the work (the catalog's discount for real queries).
  - etcd writes on three 8-vCPU members.
  - ElastiCache for Redis 7 on 4 vCPUs.
  - redis-benchmark on 2 vCPUs.
- **What they changed.**
  - PostgreSQL's numbers held.
  - etcd was half as fast as measured at twice the latency; it now has an 8-vCPU size at 45,000 writes and 1.5 ms.
  - Redis was Redis 6's single thread; Redis 7 measures 400,000 commands a second on 4 vCPUs.
- **The corpus.**
  - The rate limiter's and chat's Redis went from 12 and 8 shards to 4.
  - The URL shortener's no-near-cache mutant is now caught at the database's bulkhead, not at a Redis shard.
  - News feed's celebrities-from-shared-cache mutant is gone, since a shard and its replica carry every fan at peak; a timeline service capped below what merging celebrities needs takes its place.
  - All 123 mutants are caught.
- **The inspector.** "Checked against benchmarks" shows each run as measured and as replayed.

**Part 5, request units and bandwidth (as built).** Requests are metered as providers meter them, and the network is a resource ([ADR 0011](../adr/0011-work-units-and-bandwidth.md)).
- **Request units.** DynamoDB counts units of item size: an eventually consistent read takes half a unit per 4 KB, a write one per 1 KB, and a read of a missing item the smallest read. SQS counts a request's payload in 64 KB chunks, so a batch of small messages is one request. Capacity, prices and per-key limits are in units.
- **Bandwidth.** Caches, relational databases and Cassandra have their baseline bandwidth from AWS (ElastiCache node types, the EC2 instance an RDS class runs on). The values reads return fill it, and a hot key's bytes land on its shard.
- **The corpus.**
  - News feed's celebrities-from-shared-cache mutant is back, caught by the network: 450,000 lookups a second of 1.6 KB lists is about 5.8 Gbps on a shard whose nodes send 2.5 each.
  - DynamoDB reads cost half.
  - All 124 mutants are caught, and no golden's score changed.
- **Shown.** The inspector lists request units and bandwidth with their sources. The load panel and the headroom finding say when the network is what fills up.

**Part 6, load balancer capacity units (as built).** A managed load balancer bills by connections and bytes, as ALB does ([ADR 0012](../adr/0012-load-balancer-capacity-units.md)).
- **What it needs.**
  - Every operation clients request has request and response sizes on the wire.
  - Each problem says how its clients use connections: requests per connection, and how long one stays open. Where a scenario gives clients' WebSockets, those are the open connections.
- **What it bills.** ALB's capacity unit, as published: 25 new connections a second, 3,000 open connections, or 1 GB processed an hour, whichever needs the most, at $0.008 an hour.
- **Proxies' bandwidth.** NGINX and Kong forward every request and response, and the instance they stand for (c6i.xlarge) has a baseline of 1.562 Gbps.
- **The corpus.**
  - A short link's click is a new visitor's connection, so ALB in front of 100,000 redirects a second takes 4,000 units, about $23,000 a month, and fails S3's budget.
  - The three URL-shortener goldens that pass S3 front their services with NGINX fleets instead, and a new mutant (`alb-for-redirects`) keeps the lesson: 125 mutants, all caught.
  - The rate limiter's API clients reuse their connections, so its ALB is billed by bytes ($12,600 a month on an average day), and the news feed's pages by bytes too ($21,300). Both stay within budget.
- **Shown.** The inspector lists capacity units with their source; the load panel shows a load balancer's units, the cost summary their total, and the budget check what sets them.

## M22: Zones and regions

Where a design runs, and what it survives when part of a region, or a whole region, is lost. In parts, like M21:

**Part 1, availability zones (as built).** Components spread their instances over up to three zones, and a lost zone takes every instance in it ([ADR 0013](../adr/0013-availability-zones.md)).
- **Placement.** `zones` on a component, 1 by default. Managed offerings span zones on their own.
- **A lost zone.**
  - Fleets lose the zone's share of their instances.
  - Stores fail over to a replica in another zone, or lose everything when their replicas shared it.
  - Shards with one instance lose their keys, and quorum stores (etcd, Cassandra) stop when one zone held a majority of a shard's replicas.
  - Autoscaled fleets keep the instances they ran before the outage, without new ones (static stability).
- **The check.** `no-single-point-of-failure` with `scope: zone` names what goes down with a zone, and why.
- **The corpus.**
  - The URL shortener's S6 loses a zone at peak.
  - Its goldens run in three zones and scale to 60%, so that two zones carry the peak; the fixed fleets grew by a third.
  - Memcached, with one copy of each key, takes a third of the cache with a zone, so the MySQL golden no longer expects to pass S6.
  - Six mutants keep the lesson: 131 in all, every one caught.
- **Shown.** A Zones control in the inspector, zones on the nodes, and faults that only cost instances in amber.

**Part 2, failover times (as built).** How long writes fail when a primary is lost comes from the catalog, so recovery depends on the store chosen ([ADR 0014](../adr/0014-failover-times.md)).
- **The catalog.** PostgreSQL and MySQL fail over in 35 s, as AWS publishes for a Multi-AZ DB cluster; managed stores fail over unseen.
- **Timelines.** A failover without an end lasts as long as the store's. A lost zone fails over the primaries it held for as long, and the timeline marks when each store has failed over.
- **Placement.** Each shard's replicas start one zone further than the shard before, so primaries spread over the zones.
- **The corpus.**
  - S6's failover timeline ends with the store, and creates must be back within 45 seconds of losing the primary.
  - A new timeline loses a zone at peak for good: redirects stay at 99.9% before any replacement starts, creates are back within 45 seconds, and two predictions ask what happens to each.
  - Every golden keeps its scores, and the zone mutants also fail the new timeline: 131 mutants, all caught.

**Part 3, traffic between zones (as built).** Crossing zones costs time and money, and zone-aware routing saves both ([ADR 0015](../adr/0015-traffic-between-zones.md)).
- **Round trips.** 0.1 ms within a zone and 1 ms between zones, by the share of calls that cross; replicas acknowledge from where they are.
- **Transfer charges.** $0.01 a GB at each end that pays: EC2 instances at both ends, RDS and ElastiCache at neither, nothing through an Application Load Balancer or to DynamoDB and SQS. The component making the calls carries the cost.
- **Zone-aware routing** on a connection keeps calls in their zone as far as the target's instances there can take them; writes still go to the primary or the leader.
- **The check.** `zone-local-calls` names the connections whose crossings routing would avoid, and the saving.
- **The corpus.**
  - The URL shortener's goldens route within their zones; without it, NGINX's hop alone costs about $3,100 a month at S3's average load.
  - Click messages are 100 bytes, not the link.
  - The MySQL and Memcached golden no longer passes S3: Memcached's one copy of a key is in one zone, and reaching it crosses zones two times in three.
  - Two mutants: 133, every one caught.
- **Shown.** A Zones section on connections, and costs between zones on components and totals.

**Part 4, a standby region (as built).** A design can keep a standby copy of its components in a second region, and survive losing the primary one ([ADR 0016](../adr/0016-a-standby-region.md)).
- **Placement.** `regions: 2` on a component: the standby copy is placed like the primary one, runs its minimum instances, and takes no traffic until the primary region is lost (active-passive).
- **A lost region.** Everything without a standby copy goes. Over time:
  - every request fails until DNS sends clients to the standby region, 150 s on (Route 53's three checks 30 s apart, then a 60 s TTL);
  - RDS standbys take writes once promoted, three minutes after the region is declared lost; DynamoDB global tables need no promotion;
  - standby fleets scale up from their minimum, and caches nothing kept filled start empty.
- **What it costs.** The standby copies' instances, a second copy of the stored data, writes a pay-per-request store applies twice, and $0.02 a GB for what stores and Global Datastore caches replicate.
- **The checks.** `no-single-point-of-failure` with `scope: region`, and `no-acknowledged-data-loss` for a lost region, with `maxLossSec` as the accepted RPO.
- **The corpus.**
  - A new URL shortener scenario, S9, loses the primary region at peak. Redirects must be back within four minutes, creates within five, and at most the last second of links may be lost, for up to $80,000 a month.
  - Two new goldens keep a warm standby of the Postgres and DynamoDB designs: $75,367 and $60,464 a month, so neither passes S3's budget.
  - Four mutants: 137, every one caught.
- **Shown.** A Regions control in the inspector, a "standby region" tag on nodes, and the standby region's cost on components and totals.

**Next.** M23, replication and consistency: active-active regions, and what concurrent writes in two regions do to unique codes.

## M23: Replication and consistency

What replicas give up for the capacity they add, and what two regions taking writes at once do to unique codes. In parts, like M22:

**Part 1, reading your own writes (as built).** A read right after a write can miss it, and consistency has a price ([ADR 0017](../adr/0017-reading-your-own-writes.md)).
- **Consistent reads.** `consistent: true` on a store read sees every acknowledged write:
  - where replicas serve reads, only the primary serves it, so it weighs `replicas` ordinary reads;
  - a quorum store reads a majority;
  - DynamoDB takes a full read unit instead of half of one.
- **Which stores lag.** DynamoDB's default reads, and replicas, unless replication is synchronous. Semi-synchronous replication waits for a replica to receive a write, not to apply it.
- **The check.** `read-your-writes` asks that every way a read answers "not found" from a store that can lag be covered by a cache the write fills, a consistent read, or synchronous replication. It says how long a negative cache keeps the wrong 404.
- **The corpus.**
  - S2 asks that a link redirect the moment it is created. Every golden that redirects failed it.
  - Seven now fill their cache on create, and `dynamodb-direct` reads consistently.
  - Three mutants: 140, every one caught. One makes every cache miss consistent, and S4 shows the primary cannot take the misses when the cache goes.
- **Shown.** A "Consistent read" setting on store reads in the flow editor.

**Part 2, both regions taking traffic (as built).** Active-active, and what writing in both regions does to unique codes ([ADR 0018](../adr/0018-both-regions-taking-traffic.md)).
- **The decision.** A workload's `regionMode` names a decision: `active-passive` or `active-active`.
- **Serving.** Components with a standby copy run both copies: fleets have twice the instances and range, and stores serve reads in both while keeping one primary per shard.
- **Crossing.** Half the requests come from the other region. They pay 68 ms for each call to a primary-region-only component, each write or consistent read to a primary, and each write sent to the home region. Latency is computed per region, so the tail stays right.
- **A lost region.** Only its clients fail until DNS moves them; the other region's fleets keep running and its caches stay warm.
- **The check.** `unique-across-regions`: a conditional create checked in each region against a store that takes writes in both (a DynamoDB global table, last writer wins) lets two people claim the same alias. Send creates to the home region (`homeRegion`), or use a store with one primary.
- **The corpus.**
  - S9 gains it as a gate.
  - A new golden runs the DynamoDB design active-active: about the same cost as a warm standby, creates at 108 ms p99, and half the requests lost while DNS moves clients instead of all of them.
  - One mutant: 141, every one caught.
- **Shown.** "Write in the home region" on store writes, and the decision in Decisions.

**Next.** M24, resource saturation.

## M24: Resource saturation

What fills up before the CPU does. In parts, like M22 and M23:

**Part 1, connection pools (as built).** A relational database runs one statement per connection, and accepts only so many ([ADR 0019](../adr/0019-connection-pools.md)).
- **Pools.**
  - Every caller instance keeps a pool to each copy of the database it calls: `poolSize` on the connection, 10 by default as in HikariCP and node-postgres.
  - A pool holds calls a second × their latency (Little's law).
  - Beyond it, calls wait for a connection until they give up, without reaching the database.
- **The limit.**
  - Each shard's primary holds every caller instance's pool, against RDS's `max_connections`. PostgreSQL s, m and l accept 831, 3,326 and 5,000; MySQL m accepts 2,520.
  - Beyond it, the database refuses the rest.
- **A proxy.** RDS Proxy holds the callers' pools instead, for 2 ms a call and $0.015 an hour per vCPU behind it.
- **The check.** `connection-pools` shows the sums: instances × pool size against the limit, and calls a second × latency against the pool.
- **The corpus.**
  - S4 gains `pools-without-the-cache`, S5 `connections-at-spike`. No golden moved: the busiest pool is 57% full with the cache down, and the largest fleet holds 1,110 of 5,000 connections at the spike.
  - Two mutants: 143, every one caught. Pools of 50 on an autoscaled fleet open 5,310 connections at the spike. Pools of 4 sized for a warm cache run 142% busy when it is gone.
- **Shown.**
  - A "Connection pool" section on connections to the database: the pool size, and how full it is.
  - A "Connection proxy" switch on the database, and a "proxy" tag on its node.
  - Open and accepted connections in the results.

**Part 2, memory and disk (next).** The catalog's database capacity is measured with the data in memory. Next:
- the buffer cache's hit ratio from its memory and the keys' popularity, as for caches;
- reads that miss it go to the volume, whose IOPS (gp3's 3,000 baseline, provisioned up to 16,000, or io2) are the next limit.

## What-if traffic (as built)

Like breakscale's load slider, but over the scenario's own environments.
- **Multiplying the traffic.** "Traffic ×N" multiplies the shown environment's request rates and connections, and simulates them in a worker, so dragging stays smooth. The canvas and Load show the result; the score does not move.
- **The breaking point.** "Find the breaking point" steps the multiple up by 1.5 until the design breaks, then halves the distance to within 1%. It names what gives first. For example, the Postgres design's redirects break at ×3 of S2's peak, where the bulkhead to the database starts shedding; the DynamoDB design's break at ×4.2, where NGINX runs out.

## v0.4 and later (only if justified)
- Shareable read-only links (static, encoded attempt).
- An optional backend (accounts, sync, community problem packs).
