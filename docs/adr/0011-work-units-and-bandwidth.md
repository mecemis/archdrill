# ADR 0011 — Requests metered as providers meter them, and the network as a resource

**Status:** accepted · 2026-10-15 · builds on [ADR 0009](0009-every-number-has-a-source.md) and [ADR 0010](0010-calibrated-against-published-benchmarks.md)

## Context

The engine counted every call as one request, whatever it carried. Two consequences followed:

- **Wrong bills and limits.** DynamoDB meters capacity, prices and partition limits in units of item size: a read takes one unit per 4 KB (half for an eventually consistent read, the API's default), and a write one unit per 1 KB. A 6.4 KB timeline written to DynamoDB costs seven write units, not one. SQS meters a request's payload instead: a batch of ten small messages is one request.
- **A resource that was never full.** A node's network moves the values its reads return. ElastiCache's cache.r6g.2xlarge sustains 2.5 Gbps each way; it bursts to 10 Gbps for minutes only. Calibration ([ADR 0010](0010-calibrated-against-published-benchmarks.md)) made Redis's CPU realistic (400,000 commands a second on 4 vCPUs), and with that a celebrity's hot entries no longer overloaded the shard that holds them. Its network does: 450,000 lookups a second of 1.6 KB lists is about 5.8 Gbps.

## Decision

- **Request units** (`requestUnits` on a flavor). Units are counted per item (DynamoDB) or per request's payload (SQS), with the bytes one read unit and one write unit cover and the units a read takes.
  - Sizes round up, and a read of a missing item still takes the smallest read.
  - Capacity, request prices and per-key limits are all in units.
  - Per-item meters count every item of a batch; per-request meters count a batch once by its payload.
  - DynamoDB's reads are eventually consistent, at half a unit per 4 KB.
- **Network bandwidth** (`networkGbps` on a size).
  - The baseline each way, as AWS publishes it: ElastiCache node types, and the EC2 instance an RDS class runs on.
  - The values reads return (a cache hit, a found row) count against every serving instance's outbound bandwidth.
  - Utilisation is the fullest of a component's resources: requests (CPU or units), network, and held connections.
  - A hot key's bytes land on its shard like its requests do, each resource counted on its own.
- **Where it is computed.** Each step's units and bytes are worked out once per path, from the target's flavor and the entity's size. The propagation loop reads them by index, and the evaluation budget is unchanged (p95 63 ms against 100 ms).
- **Shown.** The inspector lists a flavor's request units and a size's bandwidth with their sources. The load panel says when the network is what limits a component, and so does the headroom finding.

## Consequences in the corpus

- **DynamoDB reads cost half.** The URL shortener's direct-DynamoDB design, expected not to pass S5, scores 20 instead of 10.
- **Celebrities' hot entries are caught by the network.** The news feed's celebrities-from-shared-cache mutant, gone since calibration, is back: the shard holding the celebrities fills its network before its CPU.
- **Two shards for 50 million timelines** now also run out of network at peak: 300,000 reads a second of 6.4 KB is about 15 Gbps.
- No golden's score changed, and all 124 mutants are caught.

## Known gaps

- **Inbound traffic is not counted.** That is writes, and the copies a primary sends its replicas. Every scenario's limit is on what reads return, and inbound has its own budget of the same size.
- **Services and load balancers have no bandwidth (proxies closed in M21).** Operations now carry request and response sizes, and proxies count what they forward ([ADR 0012](0012-load-balancer-capacity-units.md)). Services still have no bandwidth.
- **Bursting is not modelled.** A spike shorter than an instance's burst allowance would get up to 10 Gbps. The engine takes the baseline for every step.
- **Read consistency is fixed.** Strongly consistent and transactional reads cost DynamoDB two and four times as much, and a design cannot choose them yet.
- **Packets and connections per second.** The instance-level allowances that EC2 enforces besides bandwidth are not modelled.
