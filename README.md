# ArchDrill

Scenario-based system design practice with deterministic simulation and evaluation.

You design **one architecture** for a problem, then drive it through **scenarios**: write path, read path, caching, peak traffic, failures, and edge cases. Each scenario is evaluated on how the design *behaves*, not on which component names appear. The analysis covers paths, data flow, configuration, and simulated load and faults, and every finding points at the part of the canvas that caused it.

> **Status:** design phase and foundations (milestone M0). See the [roadmap](docs/design/07-roadmap.md).

## Why

Most system design practice tools reward placing familiar components (a cache, a queue, a CDN) on a canvas. Interviews reward knowing what happens on a cache miss, when the cache is down, when two users create the same short code at the same time, or when a link goes viral. ArchDrill evaluates those behaviours:

- **Flows with branches.** Requests are recorded through the topology with explicit outcomes (hit/miss, found/notFound, conflict, error), and every resulting path is analysed.
- **Capability-based checks and strategies.** Several valid designs are accepted (for example KGS, random codes with conditional writes, or obfuscated counter ranges for unique codes).
- **Analytic simulation.** Cache memory drives the hit ratio, the hit ratio drives database load, and database load drives p99, cost, and survival under faults.
- **A trustworthy evaluator.** A golden corpus of valid designs must pass and a mutant corpus of broken designs must fail. Both are enforced in CI.

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
pnpm test        # unit tests (Vitest)
pnpm check       # Biome lint/format check + TypeScript
pnpm build       # production build
```
