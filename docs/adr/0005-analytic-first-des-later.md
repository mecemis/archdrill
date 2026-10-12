# ADR 0005 — Analytic simulation first, discrete-event later

**Status:** accepted · 2026-10-12

## Decision
v0.1 ships an analytic steady-state engine:

- load propagation over path probabilities;
- Che approximation for caches;
- Sakasegawa queueing;
- Gamma-matched path latency mixtures;
- a fixed point for overload, timeouts, and retries.

v0.2 adds a seeded discrete-event engine for transient behaviour (stampedes, retry storms, autoscaling lag, failover timelines).

## Consequences
- Instant feedback on every edit. Most failure scenarios are covered deterministically.
- Transient phenomena wait for v0.2. A CI test keeps both engines in agreement in steady state.
