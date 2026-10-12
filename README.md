# ArchDrill

Scenario-based system design practice with deterministic simulation and evaluation.

You design **one architecture** for a problem, then drive it through **scenarios**: write path, read path, caching, peak traffic, failures, and edge cases. Each scenario is evaluated on how the design *behaves*, not on which component names appear. The analysis covers paths, data flow, configuration, and simulated load and faults, and every finding points at the part of the canvas that caused it.

> **Status:** milestones M1 (walking skeleton), M2 (analytic simulation) and M3 (write path and strategies) are complete. The URL Shortener's write path (S1), read path (S2) and caching scenario (S3) run end to end: design, record, analyse, simulate, score, explain. See the [roadmap](docs/design/07-roadmap.md).

![A gate finding: the cache-miss path answers 302 without reading the store; the offending path is highlighted on the canvas and in the step tree](docs/media/m1-gate-finding.png)

## Why

Most system design practice tools reward placing familiar components (a cache, a queue, a CDN) on a canvas. Interviews reward knowing what happens on a cache miss, when the cache is down, when two users create the same short code at the same time, or when a link goes viral. ArchDrill evaluates those behaviours:

- **Flows with branches.** Requests are recorded through the topology with explicit outcomes (hit/miss, found/notFound, conflict, error), and every resulting path is analysed.
- **Capability-based checks and strategies.** Several valid designs are accepted (for example KGS, random codes with conditional writes, or obfuscated counter ranges for unique codes).
- **Analytic simulation.** Cache memory drives the hit ratio, the hit ratio drives database load, and database load drives p99, cost, and survival under faults.
- **A trustworthy evaluator.** A golden corpus of valid designs must pass and a mutant corpus of broken designs must fail. Both are enforced in CI.

## What works today

- **Topology editor:** components from a catalog (clients, load balancers, API gateways, services, Redis/Memcached, PostgreSQL/MySQL, DynamoDB, key generation services, etcd/ZooKeeper), connections, sizes, replicas, shards and entity bindings.
- **Flow recorder:** each operation's request flow is recorded step by step, with every outcome (hit, negativeHit, miss, found, notFound, expired, conflict, error) as an explicit branch.
- **Several valid write paths:** a key generation service, random codes with conditional inserts, counter ranges with obfuscation, or URL hashes. The evaluator names the approach a flow implements and checks it against the declared decision, and catches the check-then-insert race.
- **Decisions:** interview trade-offs such as code strategy, code length and redirect status. Some feed the simulation: code length sets the keyspace, and with it the collision rate.
- **Path explorer:** every path a request can take, with its outcome sequence and final status. Hovering a path highlights it on the canvas.
- **Analytic simulation:**
  - cache hit ratios from memory, TTL and Zipf-skewed popularity;
  - code collisions from keyspace occupancy, and the retries needed to absorb them;
  - exact M/M/c queueing and latency percentiles over every path;
  - overload that cascades through fallbacks;
  - monthly cost, including storage for every replica's copy.
- **Load view:**
  - per environment (average, peak): operations, components, caches, cost breakdown;
  - utilisation on the canvas and request rates on connections.
- **Evaluator:** gates, severity caps, weighted dimensions, senior signals, and findings that say what was checked, what was found, why interviewers care, and how to fix it.
- **Tests:**
  - over 250 unit and integration tests;
  - a golden corpus of five valid designs and thirty-two mutants that CI must catch;
  - Playwright tests that walk the core loop in a real browser.

![Load view at peak: utilisation on every component, request rates on connections, and the cost breakdown](docs/media/m2-load.png)

![Write path: with 7-character random codes and a single retry, 0.2% of creates collide twice at 5-year occupancy; the finding names the conflict step, and the Decisions panel shows the recognised approach](docs/media/m3-write-path.png)

## Design documents

| Doc | Contents |
|---|---|
| [01 Product](docs/design/01-product.md) | Vision, core loop, principles, goals, success criteria |
| [02 Domain model](docs/design/02-domain-model.md) | Catalog, capabilities, actions and outcomes, problem packs, scenarios, attempts, flows |
| [03 Evaluation](docs/design/03-evaluation.md) | Pipeline, path analysis, check library, strategies, scoring, feedback, reliability |
| [04 Simulation](docs/design/04-simulation.md) | Analytic engine (cache, queueing, latency mixtures, retries, faults, cost) and DES |
| [05 UX](docs/design/05-ux.md) | Layout, modes, flow recorder, results dock, cross-scenario awareness |
| [06 Architecture](docs/design/06-architecture.md) | Stack, packages, data flow, persistence, testing, CI |
| [07 Roadmap](docs/design/07-roadmap.md) | Milestones and acceptance criteria |
| [URL Shortener](docs/problems/url-shortener.md) | The first problem pack: scenarios S1–S8, golden designs, mutants |
| [ADRs](docs/adr/) | Architecture decision records |

## Development

Requires Node.js ≥ 22 and pnpm 10.

```bash
pnpm install
pnpm dev         # web app on http://localhost:5173
pnpm test        # unit, integration and corpus tests (Vitest)
pnpm e2e         # browser tests (Playwright; uses the installed Chrome locally)
pnpm check       # Biome lint/format check + TypeScript
pnpm build       # production build
```
