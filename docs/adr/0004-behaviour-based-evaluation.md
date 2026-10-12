# ADR 0004 — Behaviour-based, capability-driven evaluation

**Status:** accepted · 2026-10-12

## Decision
- No component earns points for being present.
- Checks are written against capabilities and run over path, dataflow, topology, configuration, decision, and simulated-metric facts.
- Requirements are satisfied by any recognised strategy from an OR-group. Unrecognised approaches that meet outcome checks get outcome credit and a review prompt.
- Gates cap the scenario score at 40.
- Senior and staff checks are signals and never penalise a correct baseline.

## Consequences
- More valid designs are accepted (fewer false negatives), and buzzword designs fail (fewer false positives).
- Authoring a problem costs more: strategies, golden designs, and mutants. That is the price of trust, and it is tooled.
