# Authoring a problem pack

A problem pack is YAML under `packages/content/problems/<problem-id>/`. It is compiled and validated at build time, and CI holds it to a corpus of designs that must pass and designs that must fail.

**Editor support.** JSON Schemas for every kind of file live in `packages/content/schema/`, generated from the same schemas that validate content (`pnpm schemas` regenerates them; a test fails when they are stale). Every YAML file starts with a line that points editors at its schema, so editors with YAML language support (VS Code with the YAML extension, JetBrains IDEs) complete fields and flag mistakes as you type:

```yaml
# yaml-language-server: $schema=../../../schema/scenario.schema.json
```

A test checks that every content file has this line.

```
packages/content/problems/url-shortener/
  problem.yaml            # requirements, entities, operations, events, decisions
  scenarios/s1-create.yaml …
  corpus/golden/*.yaml    # valid designs and the scores they must reach
  corpus/mutants.yaml     # broken variants and the checks that must catch them
```

Register a new pack in `packages/content/src/index.ts`, and its corpus in `packages/content/test/corpus.ts`. The app offers every registered pack in a problem picker; each problem keeps its own design in the browser.

## problem.yaml

- `requirements`: functional (`FR-n`) and non-functional (`NFR-n`) requirements; checks cite them.
- `entities`: what is stored, with its key, fields and average size. `ephemeral: true` marks short-lived entities (rate counters, block markers) that may live in memory-only stores. `existsFor: <fact>` says entries exist only for requests with that fact. `hotFor: <fact>` makes the entity's one hot key the target of requests with that fact (a celebrity's recent posts, read by all their followers).
- `counts`: numbers that size fan-out steps, with a label and a default (`{ id: followers, label: followers of the author, default: 200 }`). Request classes override them (`counts: { followers: 50000000 }`), and a call step with `each: followers` is made once per follower.
- `client`: the client a new design starts with (`{ flavor: api-client, label: API clients }`; visitors in a browser by default).
- `operations`: each with `id`, `label`, `class` (`read`/`write`), `idempotent`, `successStatuses` and `requirements`. How it starts is its `trigger`:
  - a client request (the default) needs a `method` and a `path`;
  - `{ type: event, event: link-created }` makes it a consumer of that event;
  - `{ type: schedule, description: … }` makes it a background job.
- `events`: things that happen to an entity and can be published to a queue (`{ id, label, entity }`).
- `logic`: the local decisions a handler can make in this problem (`checkExpiry`, `validateUrl`, …), from the logic catalog in `packages/model/src/catalog/logic.ts`. The flow recorder offers only these, and validation rejects others. Leave it out to offer every one; `logic: []` offers none.
- `decisionPoints`: trade-offs a diagram cannot show, with options and an optional `default` the simulation assumes until the candidate decides.
- `estimates`: back-of-envelope questions for the estimation gym. Each has a `question`, a `kind` (`count`, `rate`, `bytes` or `byte-rate`), the `answer` in base units (items, bytes, per second), a `tolerance` factor (2 by default) and a `derivation` shown once the candidate has answered. State in the question any number the brief does not give. Derived numbers in `scale` notes are hidden until the estimates are answered.
- `scenarios`: the scenario ids, in order.

## A scenario

```yaml
id: s7-edge-cases
problemId: url-shortener
title: Edge cases
order: 7
story: |                   # the interviewer's prompt
optionalOperations: [purge-expired]   # focus operations a design may do another way
focusOperations: [create-link, redirect, purge-expired, scan-link]
workload: …                # traffic and environments, see below
dimensions: { correctness: 0.45, security: 0.25, operability: 0.2, latency: 0.1 }  # sum to 1
checks: …                  # see below
hints: [ … ]               # revealed one at a time, last one closest to an answer
debrief: |                 # follow-up questions, shown once the scenario passes
```

### Workload

- `operations.<id>`: the entity the requests address and their **classes** with shares that sum to 1. Facts about a class decide its outcomes:
  - flags with a field of their own: `exists: false` (unknown keys), `expired`, `disabled`, `invalidInput`, `customAlias`, `aliasTaken`, `hotKey` (every request asks for one key), `malicious`;
  - any other fact goes in `facts: [overLimit]`.

  A logic step or a call with two answers names the fact that decides it (`decidedBy` in the catalog): `checkExpiry` answers `expired` for classes with the `expired` fact, `external.check` answers `malicious` for classes with `malicious`. Validation rejects a fact that nothing decides on, which catches typos. Consumers get no workload: they receive the classes of the messages published to them.
- `keys`: Zipf popularity of existing and absent keys, which drives cache hit ratios.
- `dataset`, `keyspace`, `replication`: stored entities (for storage cost and collisions), the keyspace and the decision that sets code length, and the decision that sets the replication mode.
- `timelines` (optional): how the design behaves over time. Each has a `durationSec`, a `stepSec`, starting `rates`, and `events`:
  - `load`: new rates, at once or over `rampSec`, with `curve: linear` or `exponential`;
  - `fault`: a fault from `at` until `until`;
  - `restart`: components that lose what they hold in memory.

  A timeline can also carry `predictions`: questions the candidate answers before the charts are shown. Each has a `question`, a `measure` and `options`:
  - measures: `peak-utilization` (of a `target` selected like a fault's), `lowest-success` (of an `operation`), and `recovery-seconds` (of an `operation`, back at `threshold` `after` a moment);
  - options are increasing ranges: every option but the last has a `below` bound, and the answer is the first range the measured value falls in.

  Ask about what the timeline teaches, and set the bounds so that a typical good design and a typical weak one land in different options, away from the bounds. A corpus test checks that every question gets at least two different answers across the goldens and the scenario's mutants.

  Checks `timeline-holds` and `timeline-recovers` refer to timelines by id. Keep steps coarse for long timelines (5 s for ten minutes): a step whose state moves costs about a millisecond.
- `environments`: each with `rates` (requests or job items per second; never for consumers), optional `connections` (clients holding a persistent connection), optional `classShares` overrides, and `faults`. A fault picks components by role, never by id: `{ capability }`, `{ kind }`, `{ handlerOf: <operation> }` or `{ holds: <entity> }`, with kinds `down` (crash or hang, all, one node or one shard), `slow`, `degraded` and `failover`.

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
| `no-sync-write-on-read-path`, `publishes-without-waiting`, `event-consumed`, `idempotent-consumer-writes` | Reads stay reads; events are published without waiting and consumed; increments survive redelivery |
| `limits-are-global` | Rate limits are checked against a count every server shares |
| `no-dual-write` | An event is written with the data it reports (transactional outbox) |
| `expired-data-removed` | A job deletes expired data, or the store expires it through TTLs |

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
