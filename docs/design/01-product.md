# 01 — Product

## Vision

ArchDrill is a deliberate-practice environment for system design interviews. A candidate designs **one architecture** for a problem and then drives it through a sequence of **scenarios**: the write path, the read path, caching, peak traffic, failures, and edge cases. Each scenario is evaluated deterministically on the behaviour of the design, not on the presence of familiar component names. Every result comes with an explanation the candidate can act on.

The product answers one question well: *"If an interviewer pushed on this part of my design, would it hold up, and why or why not?"*

## Who it is for

| Persona | Need | What ArchDrill gives them |
|---|---|---|
| **Candidate** (primary): senior/staff engineer preparing for interviews | Practise deep dives, find blind spots, build intuition for numbers and failure modes | Scenario-by-scenario drills, path-level feedback, simulation of load and faults, senior/staff "signals" |
| **Author** (secondary): someone adding problems | Define scenarios and evaluation without writing UI code | YAML problem packs, a check library, strategy registry, golden/mutant test harness |

## Core loop

1. **Read the brief.** Functional and non-functional requirements, scale numbers, constraints.
2. **Estimate** (optional). Back-of-envelope numbers are checked within tolerance bands (the estimation gym, M11).
3. **Build the topology.** Place components from the catalog on the canvas, wire connections, and configure them (sizes, replicas, shards, TTLs, replication, policies).
4. **Work through scenarios in order.** For each one:
   - read the scenario story: what the interviewer is pushing on, the workload, and any faults;
   - record or refine the **flows** for the operations in focus by clicking through the topology, including branches (hit/miss, found/notFound, conflict, error);
   - make the **decisions** the scenario asks for (for example 301 vs 302, ID strategy, replication mode).
5. **Evaluate.** Runs automatically on every change, debounced. The scenario report shows:
   - gates;
   - per-dimension scores;
   - recognised strategies;
   - metrics (load, utilisation, p50/p99, error rate, hit ratio, cost);
   - findings, each linked to evidence on the canvas.
6. **Iterate.** Changing the shared architecture re-evaluates *every* scenario. Regressions ("fixing failover broke read latency") are surfaced, because that is where trade-offs become real.
7. **Debrief.** After a scenario passes, the candidate sees what interviewers typically probe next, common mistakes, and the senior/staff signals still on the table.

## Principles

1. **Behaviour over presence.** No component earns points for existing. Points come from checks over flows, configuration, and simulated outcomes.
2. **One architecture, many scenarios.** Scenarios are flows × conditions over a single shared design, mirroring a real interview.
3. **Multiple valid answers.** Checks are written against *capabilities* (for example "conditional write", "volatile key-value"), not product names. Requirements are satisfied through named alternative *strategies*. Outcome checks are solution-agnostic by construction.
4. **Explainable and traceable.**
   - Every point maps to a check.
   - Every check maps to a requirement.
   - Every finding points at the nodes, connections, steps, or paths that caused it.
5. **Deterministic and tested.** The same design and the same scenario always produce the same result. The evaluator is guarded in CI by a golden corpus (valid designs that must pass) and a mutant corpus (broken designs that must fail).
6. **Fast feedback.** Static analysis plus the analytic simulation complete in well under 100 ms for typical designs, so evaluation can run live.
7. **Honest models.** Capacities, latencies, and costs are documented ballparks with stated assumptions. The UI shows ranges and orders of magnitude, and scores depend on behaviour (did the database saturate? did requests fail?), not on exact milliseconds.

## Goals (v0.1)

- One problem, URL Shortener, implemented in depth: 7 scenarios plus an advanced analytics scenario in v0.2.
- A shared-architecture editor with typed component configuration and connection policies.
- A flow recorder with branches, and a path explorer that shows every enumerated path with its probability, latency, and outcome.
- An evaluator with gates, weighted dimension scores, a strategy registry, senior/staff signals, and evidence-linked feedback.
- An analytic simulation covering:
  - load propagation;
  - cache hit ratio from cache size and key popularity;
  - queueing latency and percentiles;
  - overload;
  - timeouts and retry amplification;
  - fault states;
  - cost.
- A golden corpus of at least 6 valid alternative designs, a mutant corpus of at least 25, and a CI mutation score of 100%.
- Local persistence and versioned JSON export/import.

## Non-goals

- An AI interviewer or chatbot. Every interaction is structured and every evaluation is deterministic.
- Deploying or emulating real infrastructure, or packet-level fidelity.
- Free-form whiteboard drawing as the primary input. Notes are allowed, but evaluable input is structured.
- Multiplayer or accounts in v0.1.
- Breadth for its own sake. A few deep problems beat many shallow ones.

## Success criteria

| Criterion | Target |
|---|---|
| Valid alternative designs (golden corpus) | All score ≥ 80 on every scenario they target |
| Broken designs (mutant corpus) | 100% detected, each by the specific check that should catch it |
| "Buzzword" design: every popular component wired in one chain, with no flows that use them | Not passing on any scenario |
| Evaluation latency, static + analytic | p95 < 100 ms on a 30-component design |
| Full attempt of URL Shortener S1–S7 | Completable in 60–90 minutes by a prepared candidate |
| Every finding | Has evidence on the canvas and a fix suggestion |

**Status (M7).**

- Five criteria are enforced in CI: the golden and mutant corpora, the buzzword design, the evaluation budget (`pnpm report`), and evidence plus a fix for every finding across the corpus. Decision findings point at the decision under *Decisions*.
- The 60–90 minute run-through of S1–S7 is a manual criterion. It is checked with timed walkthroughs before v0.1 is announced.

## What makes it useful rather than a toy

- **Path explorer.** The candidate sees every path their design can take (for example `redirect · cache miss → db found → populate → 302 · 9.4% · p99 11 ms`). Seeing the paths is itself the lesson.
- **Numbers that move with decisions.**
  - Cache memory size changes the hit ratio.
  - The hit ratio changes database load.
  - Database load changes p99.
  - A short TTL for takedown compliance costs hit ratio, and the candidate sees how much.
- **Failure behaviour is computed, not asserted.**
  - Taking the cache down shows whether the database survives the miss storm.
  - Retries without bounds show load amplification.
  - Ack-before-durable-write shows data loss on failover.
- **Interview framing everywhere.**
  - Findings say why an interviewer cares.
  - Debriefs list the follow-up questions to expect.
  - Signals show what separates a senior answer from a staff answer.
