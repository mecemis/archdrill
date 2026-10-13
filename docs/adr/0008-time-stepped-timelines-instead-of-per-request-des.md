# ADR 0008 — Time-stepped timelines instead of a per-request discrete-event engine

**Status:** accepted · 2026-10-13 · supersedes the engine choice in [ADR 0005](0005-analytic-first-des-later.md)

## Context

v0.2 shows how a design behaves over time: a cold cache after a restart, autoscaling that lags behind a spike, a failover from detection to reconnection, a backlog that builds and drains, circuit breakers that open and close. ADR 0005 planned a per-request discrete-event engine (DES) for this, simulating a sampled fraction of requests with capacities scaled to match.

Two problems with that plan surfaced when designing it:

- **Volume.** S2's peak is 300,000 requests a second. A minute of it is 18 million requests and well over 100 million events, far beyond a two-second budget in a browser worker.
- **Sampling distorts what matters.** Sampling requests at 1/150 keeps utilisation only if capacity shrinks too. A store with four instances and forty concurrent requests each would be left with about one server. Queueing on one server behaves nothing like queueing on 160, so latency and overload, the effects the timelines exist to show, would be artefacts of the sampling.

## Decision

Timelines use a **time-stepped model** built on the analytic engine.

- **Time steps.** Time advances in steps (one second by default). In each step the engine solves the request-level quantities for that moment, warm-started from the previous step: loads, overload, timeouts, retries and latency.
- **State between steps.** What changes over time is kept as explicit state and updated every step:
  - load shapes;
  - fault windows (detection, promotion and reconnection for a failover);
  - cache warmth after a flush (a time-dependent form of Che's approximation, with request coalescing);
  - autoscaling with metric windows and provisioning delay;
  - circuit-breaker state;
  - queue backlogs that build and drain.
- **Traces.** Example requests are sampled with a seeded PRNG from each step's path probabilities and latencies.
  - *Amended in M10:* each step instead records its path mix, the exact share and mean latency of every path, which expands to per-call timings. It carries the information a sample would, deterministically and without missing rare paths.

## Consequences

- **Deterministic and fast.** A two-minute timeline is a few hundred steps of an engine that evaluates every scenario in about 50 ms.
- **Agreement by construction.** With constant load and no events, a timeline settles on the analytic steady state. A test holds them together.
- **Mean behaviour only.** Timelines show average behaviour per step, not the randomness of individual requests. Effects that only arise from chance alignment of requests are not modelled. Where they matter, they are expressed through the mean: for example, a thundering herd is the number of requests for a key that arrive while its first miss is being served.
- **Coarse retry timing.** Effects faster than a step blend into it. Retry backoffs of tens of milliseconds appear as load within the same second; retry waves are visible when backoffs are of the order of a step.
- **Leaner content.** Timelines reuse the scenario's workload, faults and checks. A timeline adds a duration, load shapes and timed events.
