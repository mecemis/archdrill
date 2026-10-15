# ADR 0010 — Calibrated against published benchmarks

**Status:** accepted · 2026-10-15 · builds on [ADR 0009](0009-every-number-has-a-source.md)

## Context

ADR 0009 made every catalog number either published or a model with its reasoning. The reasoning was still only text. "pgbench measures 15,000 reads a second per vCPU; the catalog takes a sixth" explains a number, but nothing checked that the engine, given that number, behaves like the database it stands for. Two kinds of error could hide:

- **A wrong model.** A capacity "kept at low latency" was discounted for latency that the engine's own queueing model adds again.
- **A number that disagrees with another.** A service time and a capacity can each look plausible and together give the wrong curve: throughput that saturates at the wrong concurrency, or latency off by half.

Published benchmarks give more than a peak figure. pgbench at 4, 16, 32, 50, 100 and 200 clients, and etcd at 1 and 1,000, trace how throughput and latency move with load. The engine models every component as a queue (capacity, a service time, and as many requests in service as capacity × service time, after Little's law), so it can be run the way a benchmark runs.

## Decision

The catalog lists **calibrations**: published benchmarks the engine must reproduce, run by run, within 15%.

- **What a calibration says.**
  - The size the benchmark ran on, with as many replicas as it had.
  - How it ran, in a sentence or two.
  - Where its clients sat: in the servers' zone, or elsewhere in the region.
  - The share of reads.
  - The runs, with what each measured and nothing it did not: clients and the throughput or mean latency they saw, or a fixed rate and the median.
- **The replay.** The engine builds the size from the catalog with `componentProfile`, the same function a design uses, and asks `componentLatency` what one visit costs at a given load.
  - **Closed runs.** Clients send their next request when the last returns, so throughput settles where X = clients ÷ (latency at X + round trip).
  - **Open runs.** The latency distribution at a fixed rate.
- **Network.** A round trip is 0.1 ms within a zone, and 0.5 ms (the engine's per-hop figure for designs) elsewhere in the region.
- **Work.** A benchmark's requests can be lighter than the ones the catalog stands for. A pgbench select reads one tiny row by primary key; the catalog's reads are real queries. A calibration states the ratio and why. The replay gives the size that many times its throughput and that fraction of its service time, with as many requests in service at once. The ratio is the model's discount, now a number a test holds.
- **Beyond the model.** A run the engine is known to miss is marked so, and the calibration says why. The test also fails if a marked run starts to fit, so the mark cannot outlive its reason.
- **Enforced by tests.**
  - Every run lands within 15% unless marked.
  - Every calibration cites a source of kind `benchmark`.
  - The calibrated size's throughput and latency cite that source.
- **Shown in the inspector.** "Checked against benchmarks", under where the numbers come from, lists each run as measured and as replayed.

## What the first calibrations found

| Calibration | Runs | Before | After |
|---|---|---|---|
| pgbench select-only, 2 vCPUs | 4–50 clients, at most 14% off; 100 and 200 beyond the model | consistent | unchanged; the latency's model now rests on the replay instead of an assumption |
| etcd writes, three 8-vCPU members | 1 and 1,000 clients, at most 7% off | a 4-vCPU member at 10,000 writes and 3 ms: half the benchmark per vCPU, at twice its latency | an 8-vCPU size at 45,000 writes and 1.5 ms; the 4-vCPU size at half the throughput |
| ElastiCache for Redis 7, 4 vCPUs | 400 to 5,200 clients and a median, at most 13% off | 150,000 reads and 120,000 writes, from single-threaded Redis 6 | 400,000 of each: Redis 7's I/O threads, measured by AWS |
| redis-benchmark, 2 vCPUs | 50 clients, 5% off | 100,000 reads and 80,000 writes | 110,000 of each |

Redis's change moved lessons, as Part 2's URL-safety quotas did:

- **Reference designs sized for the old figure.** The rate limiter's 12 counter shards and chat's 8 were two to three times what the load needs. They now run 4 each (62% and 48% busy at their peaks), and the mutants that overload them, two counter shards and presence read contact by contact, are caught again.
- **The URL shortener's hot key.** A Redis shard with a replica now carries the viral link's 300,000 lookups a second. A design without a near cache still fails the spike, because the popular links the near cache held miss through to the database.
- **News feed's celebrities.** Every fan reading celebrities' entries from the shared cache is no longer a fault: at 300,000 timeline reads a second, half of them by fans of three celebrities, a shard and its replica carry the 450,000 lookups. That mutant is gone; one that caps the timeline service merging the entries keeps the scenario's headroom check tested.

## Known gaps

- **One service time per component.** etcd's reads take a write's 1.5 ms, where etcd measures 0.7 ms for a linearizable read.
- **Throughput that falls with too many connections.** PostgreSQL's does beyond about 25 connections a vCPU, and Redis 6's with thousands of clients. The engine holds throughput at its peak.
- **Calibrated: PostgreSQL reads, etcd writes, Redis.**
  - PostgreSQL's writes are not calibrated: a TPC-B transaction is seven round trips, which a single-step replay cannot express.
  - NGINX, Kafka, Cassandra, MySQL, ZooKeeper, Flink and the service handlers are not calibrated yet. Their models still cite what they rest on, or say they are assumptions.
- **The network round trip.** The engine's 0.5 ms per hop is a constant of its own, not a catalog number with a source. The zone figure is bounded by the benchmarks themselves: at 50 clients ElastiCache answered within 0.47 ms, service included.

## Consequences

- Changing a calibrated number means re-running a benchmark in the test suite, and changing a model's discount means changing a stated ratio. Either shows in review.
- Realistic capacities can make a scenario's numbers too small to stress a design. When a calibration moves a lesson, the corpus says so: mutants are re-based or removed, and the problem's docs record why.
- Work units come next. Requests that carry sizes and operations that carry units (DynamoDB's read units by item size, a list of posts costing more than one value) let the catalog stop treating every request alike.
