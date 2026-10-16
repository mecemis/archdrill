# About the model

ArchDrill simulates a design analytically: it solves for the steady state of each environment instead of replaying individual requests. That makes evaluation fast and deterministic, and it is enough to show the effects interviews ask about: what saturates first, what a cache miss costs, how a fault cascades, what a retry storm does. This page summarises what the model assumes. The [simulation design](../design/04-simulation.md) has the formulas.

## What it computes

- **Paths.** Every way a request can go through its flow, with the probability of each step's outcome for each class of request (live links, expired links, unknown codes, a viral link, malicious URLs).
- **Caches.** Hit ratios from cache memory, TTL and Zipf-skewed popularity (Che's approximation), with negative caching, a hot key, and in-process caches that keep one copy per instance.
- **Load and queueing.** Load on every component, retries included; M/M/c queueing per instance; latency percentiles from moment-matched Gamma distributions mixed over all successful paths.
- **Overload and faults.** Components over capacity reject the excess; faults take components down, slow them, degrade them or fail them over. A lost availability zone takes the instances each component runs in it: a component spread over three zones loses a third of them and keeps its keys, one in a single zone loses everything, and a quorum store loses its majority when one zone held it. Callers time out, retry with backoff and jitter, open circuit breakers and shed load with bulkheads.
- **Feedback.** Loads, failures, timeouts, hit ratios and autoscaling depend on each other, so the model iterates to a damped fixed point. A second solve from cold caches finds designs that a shock tips into an overload their retries sustain.
- **Background work.** Consumers receive what is published to their queue, failed messages are delivered again and then dead-lettered, and consumers or jobs that cannot keep up report a growing backlog.
- **Counting.** Fire-and-forget publishes that never hold up a request, consumers that sum per key over a window before writing (distinct keys under Zipf popularity), batched writes, counters spread over several rows, and per-key write limits such as DynamoDB's 1,000 writes a second per item.
- **Timelines.** A timeline re-solves the steady state every step, carrying over what changes at its own pace: caches warming up after a restart, autoscalers waiting for new instances, breakers holding open, backlogs building and draining ([ADR 0008](../adr/0008-time-stepped-timelines-instead-of-per-request-des.md)).
- **Cost.** Instances, storage for every stored copy, per-request prices (in units of item size where a provider counts them, and for every item of a batch), and a managed load balancer's capacity units, billed by the connections clients open and hold and the bytes it forwards.

## What it assumes

- **Steady state, step by step.** Every environment is a steady state; timelines show how it moves, one step (usually a second) at a time. Effects faster than a step blend into it, and individual requests are not replayed, so timelines show average behaviour.
- **Ballpark numbers.** Capacities, latencies and prices in the catalog are order-of-magnitude figures for comparing designs, not capacity plans or quotes.
- **Independent requests.** Requests of the same class behave alike and independently, apart from the correlations the model names: a hot key lands on one shard, a fault affects every call to the same key, and a failing message fails on every delivery.
- **One region.** Zones matter for replication acknowledgements; multiple regions and network partitions are not modelled yet.
- **Simple batches.** A batched call costs one round trip plus a small share per extra item, and items wait for their batch for at most five seconds.

## When the numbers are approximate

If the fixed point does not settle (usually because the design keeps feeding failures back into load), the results say so, and findings based on them carry a note. Treat those numbers as a direction, not a measurement.

## Why analytic first

An analytic model evaluates all eight URL Shortener scenarios of a 30-component design in about 80 ms (timelines add about 350 ms, in a background worker), so feedback arrives as you edit, and the same design always gets the same result, which is what lets CI hold a corpus of golden and broken designs to exact expectations.
