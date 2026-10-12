# ADR 0003 — One shared architecture, flows as overlays, scenarios as conditions

**Status:** accepted · 2026-10-12

## Context
The idea was for each scenario (write path, read path, cache, failure, …) to be drawn separately. Separate drawings diverge, multiply the work, and do not match interviews, where one architecture is walked through different flows.

## Decision
- **Architecture:** one per attempt; components with typed configuration and capabilities.
- **Flows:** one per operation; branching step DAGs over existing connections; shared by all scenarios.
- **Scenarios:** author-defined workload × faults × checks over chosen operations. Candidates cannot change them.

## Consequences
- Every edit re-evaluates every scenario, so cross-scenario regressions become visible.
- Probabilities (hit ratio, faults) come from scenarios, and logic comes from the candidate, which prevents gaming.
- Write/read paths are operations, and cache failure, peak, and failure are conditions: scenarios compose instead of multiplying.
