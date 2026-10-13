# ArchDrill

Scenario-based system design practice with deterministic simulation and evaluation.

You design **one architecture** for a problem, then drive it through **scenarios**: write path, read path, caching, peak traffic, failures, and edge cases. Each scenario is evaluated on how the design *behaves*, not on which component names appear. The analysis covers paths, data flow, configuration, and simulated load and faults, and every finding points at the part of the canvas that caused it.

> **Status:** milestones M1 to M7 are complete: walking skeleton, analytic simulation, write path and strategies, faults, timeouts and retries, scale (hot keys, near caches, autoscaling), asynchronous work (queues, consumers, scheduled jobs, a third-party API), and hardening (evaluation in a worker, budgets, reports and browser tests in CI). Seven URL Shortener scenarios run end to end (write path, read path, caching, cache outage and invalidation, peak traffic and hot keys, dependency failure, edge cases): design, record, analyse, simulate, score, explain. See the [roadmap](docs/design/07-roadmap.md).

![A gate finding: the cache-miss path answers 302 without reading the store; the offending path is highlighted on the canvas and in the step tree](docs/media/m1-gate-finding.png)

## Why

Most system design practice tools reward placing familiar components (a cache, a queue, a CDN) on a canvas. Interviews reward knowing what happens on a cache miss, when the cache is down, when two users create the same short code at the same time, or when a link goes viral. ArchDrill evaluates those behaviours:

- **Flows with branches.** Requests are recorded through the topology with explicit outcomes (hit/miss, found/notFound, conflict, error), and every resulting path is analysed.
- **Capability-based checks and strategies.** Several valid designs are accepted (for example KGS, random codes with conditional writes, or obfuscated counter ranges for unique codes).
- **Analytic simulation.** Cache memory drives the hit ratio, the hit ratio drives database load, and database load drives p99, cost, and survival under faults.
- **A trustworthy evaluator.** A golden corpus of valid designs must pass and a mutant corpus of broken designs must fail. Both are enforced in CI.

## What works today

- **Topology editor:** components from a catalog (clients, load balancers, API gateways, services, Redis/Memcached, PostgreSQL/MySQL, DynamoDB, key generation services, etcd/ZooKeeper, managed queues/Kafka, a URL-safety API), connections, sizes, replicas, shards and entity bindings.
- **Flow recorder:** each operation's flow is recorded step by step, with every outcome (hit, negativeHit, miss, found, notFound, expired, conflict, malicious, error) as an explicit branch. Operations start from a client request, from an event a consumer takes off a queue, or from a schedule.
- **Several valid write paths:** a key generation service, random codes with conditional inserts, counter ranges with obfuscation, or URL hashes. The evaluator names the approach a flow implements and checks it against the declared decision, and catches the check-then-insert race.
- **Decisions:** interview trade-offs such as code strategy, code length, redirect status and replication mode. Some feed the simulation: code length sets the keyspace, and with it the collision rate; replication mode sets write latency and what a failover loses.
- **Scale:** a viral link's traffic lands on the one cache shard that holds it, in-process near caches absorb it, and services autoscale between an average-day minimum and a spike maximum, so the simulation shows both the hot shard and what the spike costs on an ordinary day.
- **Asynchronous work:** a create flow publishes `link-created`; a consumer scans new links with a third-party URL-safety API and disables malicious ones; a scheduled job purges expired links in batches. The simulation derives each consumer's rate from what is published, redelivers failed messages until they are dead-lettered, and shows lag and backlog when workers fall behind. Scanning before answering and scanning in a consumer both pass, each with its own trade-offs.
- **Faults and call policies:** environments break components by role (a cache node down, the whole cache hanging, a database failing over, a server crashing). Every call a service makes follows its connection's policy (timeout, retries with backoff and jitter, circuit breaker, bulkhead), so the simulation shows miss storms, cascades through shared databases, retry storms and the latency a hanging dependency costs.
- **Path explorer:** every path a request can take, with its outcome sequence and final status. Hovering a path highlights it on the canvas.
- **Analytic simulation:**
  - cache hit ratios from memory, TTL and Zipf-skewed popularity;
  - code collisions from keyspace occupancy, and the retries needed to absorb them;
  - faults, timeouts, retries, circuit breakers and bulkheads, including retry storms that a cache flush leaves the design stuck in;
  - exact M/M/c queueing and latency percentiles over every path;
  - overload that cascades through fallbacks;
  - monthly cost, including storage for every replica's copy.
- **Load view:**
  - per environment (average, peak): operations, components, caches, cost breakdown;
  - utilisation on the canvas and request rates on connections.
- **Evaluator:** gates, severity caps, weighted dimensions, senior signals, and findings that say what was checked, what was found, why interviewers care, and how to fix it.
- **Working across scenarios:** a change that lowers another scenario's score raises a warning on that scenario's tab; a pinned baseline shows how every score moved and what changed; debriefs pose the follow-up questions once a scenario passes; designs export and import as JSON, upgraded by versioned migrations.
- **Tests:**
  - over 450 unit, integration and property tests, including the product's success criteria;
  - a golden corpus of seven valid designs and sixty-six mutants that CI must catch;
  - Playwright tests that walk the core loop in a real browser, and run the production build under its security headers;
  - a corpus report and an evaluation-time budget published by CI.

![Load view at peak: utilisation on every component, request rates on connections, and the cost breakdown](docs/media/m2-load.png)

![Hot key: without a near cache, a viral link's lookups saturate one Redis shard (104%) while the tier averages 68%, and the finding names the hottest shard](docs/media/m5-hot-key.png)

![Edge cases: a create flow checks URLs with a third-party API but lets the link through unchecked when the API errors; the gate finding names the three paths that store a link nobody checked](docs/media/m6-unchecked-path.png)

![Cache outage: Redis hangs, the redirect service sheds load at its 60,000 calls/s bulkhead, so redirects degrade to 20% while link creation on the same database stays at 100%](docs/media/m4-cache-outage.png)

![Write path: with 7-character random codes and a single retry, 0.2% of creates collide twice at 5-year occupancy; the finding names the conflict step, and the Decisions panel shows the recognised approach](docs/media/m3-write-path.png)

## Guides

| Guide | Contents |
|---|---|
| [How scoring works](docs/guides/scoring.md) | Checks, dimensions, gates and caps, bands, signals |
| [About the model](docs/guides/model.md) | What the simulation computes, what it assumes, and when numbers are approximate |
| [Authoring a problem pack](docs/guides/authoring.md) (draft) | Problems, scenarios, workloads, checks, golden designs and mutants |

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
pnpm report      # corpus report and the evaluation-time budget (Markdown in packages/content/report/out)
pnpm check       # Biome lint/format check + TypeScript
pnpm build       # production build
```

### Deployment

The web app is a static site. `.github/workflows/deploy.yml` builds it and deploys `apps/web/dist` to Cloudflare Pages on every push to `main`, with the response headers in `apps/web/public/_headers` (a strict content security policy and long caching for hashed assets). A Playwright test runs the production build under those headers. To enable it:

1. Create the Pages project once: `pnpm dlx wrangler pages project create <name> --production-branch=main`.
2. In the repository settings, add the variable `CLOUDFLARE_PAGES_PROJECT` (the project name) and the secrets `CLOUDFLARE_API_TOKEN` (with *Cloudflare Pages: Edit*) and `CLOUDFLARE_ACCOUNT_ID`.

Until then the workflow is skipped.
