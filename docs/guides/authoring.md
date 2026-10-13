# Authoring a problem pack (draft)

A problem pack is YAML under `packages/content/problems/<problem-id>/`. It is compiled and validated at build time, and CI holds it to a corpus of designs that must pass and designs that must fail. This draft covers what the URL Shortener pack uses; a JSON Schema for editors is planned for v0.3.

```
packages/content/problems/url-shortener/
  problem.yaml            # requirements, entities, operations, events, decisions
  scenarios/s1-create.yaml …
  corpus/golden/*.yaml    # valid designs and the scores they must reach
  corpus/mutants.yaml     # broken variants and the checks that must catch them
```

Register a new pack in `packages/content/src/index.ts`, and its corpus in `packages/content/test/corpus.ts`.

## problem.yaml

- `requirements`: functional (`FR-n`) and non-functional (`NFR-n`) requirements; checks cite them.
- `entities`: what is stored, with its key, fields and average size.
- `operations`: each with `id`, `label`, `class` (`read`/`write`), `idempotent`, `successStatuses` and `requirements`. How it starts is its `trigger`:
  - a client request (the default) needs a `method` and a `path`;
  - `{ type: event, event: link-created }` makes it a consumer of that event;
  - `{ type: schedule, description: … }` makes it a background job.
- `events`: things that happen to an entity and can be published to a queue (`{ id, label, entity }`).
- `decisionPoints`: trade-offs a diagram cannot show, with options and an optional `default` the simulation assumes until the candidate decides.
- `scenarios`: the scenario ids, in order.

## A scenario

```yaml
id: s7-edge-cases
problemId: url-shortener
title: Edge cases
order: 7
story: |                   # the interviewer's prompt
focusOperations: [create-link, redirect, purge-expired, scan-link]
workload: …                # traffic and environments, see below
dimensions: { correctness: 0.45, security: 0.25, operability: 0.2, latency: 0.1 }  # sum to 1
checks: …                  # see below
hints: [ … ]               # revealed one at a time, last one closest to an answer
debrief: |                 # follow-up questions, shown once the scenario passes
```

### Workload

- `operations.<id>`: the entity the requests address and their **classes** with shares that sum to 1. Class flags shape outcomes: `exists: false` (unknown keys), `expired`, `disabled`, `invalidInput`, `customAlias`, `aliasTaken`, `hotKey` (every request asks for one key), `malicious`. Consumers get no workload: they receive the classes of the messages published to them.
- `keys`: Zipf popularity of existing and absent keys, which drives cache hit ratios.
- `dataset`, `keyspace`, `replication`: stored entities (for storage cost and collisions), the keyspace and the decision that sets code length, and the decision that sets the replication mode.
- `timelines` (optional): how the design behaves over time. Each has a `durationSec`, starting `rates`, and `events`: `load` (new rates, at once or over `rampSec`) and `fault` (from `at` until `until`). Checks `timeline-holds` and `timeline-recovers` refer to them by id.
- `environments`: each with `rates` (requests or job items per second; never for consumers), optional `classShares` overrides, and `faults`. A fault picks components by role, never by id: `{ capability }`, `{ kind }`, `{ handlerOf: <operation> }` or `{ holds: <entity> }`, with kinds `down` (crash or hang, all, one node or one shard), `slow`, `degraded` and `failover`.

### Checks

Every check instance has an `id`, the check it `use`s, a `title`, a `dimension`, a `weight` (default 1; 0 makes it advisory), and the finding's `why` and `fix`. Optional fields:

- `gate: true` caps the scenario at 40 when it fails;
- `severity` (`critical`, `major` (default) or `minor`) caps the band;
- `signal: senior` or `signal: staff` reports the check without scoring it;
- `requirements` lists the requirements it verifies.

| Check | What it verifies |
|---|---|
| `no-path`, `all-success-paths-contain`, `status-for-condition`, `outcome-handled` | Path predicates: steps, outcomes, sequences and final statuses, optionally from a decision |
| `populate-after-miss`, `invalidation-on-write` | Cache data flow and staleness after writes |
| `latency-below`, `success-rate-above`, `utilization-below`, `hit-ratio-above`, `cost-within-budget` | Simulated metrics per environment (latency reads as lag for consumers and jobs) |
| `backlog-stable` | Consumers and jobs keep up |
| `timeline-holds`, `timeline-recovers` | A metric stays within bounds over a window of a timeline, or recovers soon after a moment |
| `dependency-timeout-bounded`, `retries-bounded-with-jitter`, `retry-only-idempotent`, `circuit-breaker-on-dependency`, `stable-under-retries` | Call policies and retry storms |
| `no-acknowledged-data-loss` | What a failover loses under the chosen replication |
| `no-single-point-of-failure`, `unused-components`, `ingress-has-capability` | Topology |
| `overprovisioned`, `autoscaling-configured` | Fleet sizing |
| `recognize-strategy`, `decision-excludes` | Approaches and decisions |
| `unsafe-content-stopped` | New content is checked before or after it is stored |

`validateScenarioConfig` rejects unknown checks, invalid parameters, unknown operations and requirements, and workload mistakes; the content tests run it for every scenario.

## The corpus

A golden design is an attempt plus what it must reach:

```yaml
id: postgres-redis-cache-aside
description: …
expect:
  s7-edge-cases: { minScore: 90 }
notPassing: []            # scenarios it is expected not to pass
attempt: …                # the design: the `attempt` of a file exported from the app
```

A mutant applies editor commands to a golden design and names what must catch it:

```yaml
- id: scan-skips-eviction
  base: postgres-redis-cache-aside
  description: The consumer disables a malicious link in the store but leaves it in Redis.
  apply:
    - removeStep: { operation: scan-link, stepId: evict, bypass: ok }
  expect:
    scenario: s7-edge-cases
    fails: [scan-invalidates-caches]   # or invalid: [<validation issue codes>]
```

Keep at least two golden designs per scenario that pass it in different ways, so checks reward behaviour rather than one answer. When a stronger golden design makes old mutants pass, keep the weaker design as its own golden and rebase those mutants onto it.

`pnpm report` prints every golden design's score per scenario and which checks catch each mutant; CI publishes it with every run.
