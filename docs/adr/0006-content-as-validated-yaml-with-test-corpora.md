# ADR 0006 — Problem packs as validated YAML with golden and mutant corpora

**Status:** accepted · 2026-10-12

## Decision
- The catalog and problem packs are YAML, validated with Zod at build time and compiled to JSON.
- Each problem ships golden designs, with the bands they are expected to reach, and mutant expectations, with the checks each mutant must fail.
- CI enforces both and publishes a mutation report.

## Consequences
- Authoring requires no UI code, and mistakes fail the build.
- The evaluator's trustworthiness is measured, not claimed.
