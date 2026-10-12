# ADR 0001 — New repository instead of forking system-design-simulator

**Status:** accepted · 2026-10-12

## Context
vijaygupta18/system-design-simulator (MIT, ~400★) has a polished React Flow UI and good educational content. Its core does not fit this project:

- Scoring is problem-agnostic: `scoreDesign(nodes, edges)` never receives the problem.
- Scoring is presence-based with double counting. Measured on URL Shortener: a buzzword design scores 95, the problem's own reference scores 74, and a lean correct design scores 56.
- The simulator is steady-state with 100% fan-out to every child. It has no request types, cache hit ratio, faults, or time.
- Canvas tabs are independent copies, with no shared model.
- There are no tests.

## Decision
Start a new repository with a new domain model, engine, and evaluator. Reuse ideas, and where useful MIT-licensed content (component descriptions, concept and trade-off texts), with attribution.

## Consequences
- The UI must be rebuilt, but it is designed around a shared model from day one.
- The portfolio shows original architecture work rather than a modified fork.
- Attribution is required for reused content (keep the MIT copyright notice in `NOTICE`).
