# ADR 0002 — Client-side TypeScript engine, no backend in v0.1

**Status:** accepted · 2026-10-12

## Context
Evaluation must run on every edit (< 100 ms) and be deterministic. Options considered:

1. TypeScript in the browser (Web Worker).
2. A C#/.NET engine via Blazor WASM.
3. A server-side engine (ASP.NET Core).

## Decision
A pure TypeScript engine and evaluator, framework-free, running in a Web Worker. No backend in v0.1.

## Consequences
- One language across the stack. The same code runs in tests, CI tooling, and the browser.
- No hosting cost or latency. The app is local-first.
- A backend (accounts, sync, sharing) can be added later without moving evaluation.
- Rejected: Blazor WASM (payload size, awkward interop with React Flow); server engine (round-trip per edit, state and hosting overhead).
