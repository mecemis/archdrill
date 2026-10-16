# ADR 0013 — Availability zones

**Status:** accepted · 2026-10-16 · builds on [ADR 0009](0009-every-number-has-a-source.md)

## Context

Redundancy meant a second instance: a component with two replicas passed the single-point-of-failure check, wherever they ran. Real outages are often bigger than an instance. A cloud region is built from availability zones, data centres with their own power, cooling and networking, and a zone can fail as a unit. AWS gives every region [at least three](https://aws.amazon.com/about-aws/global-infrastructure/regions_az/), within 100 km of each other and close enough for synchronous replication.

Two replicas in the same zone go down together. A fleet spread over three zones loses a third of its instances with one, and those that are left have to carry the load. Launching replacements depends on a control plane that the outage may impair, and takes minutes anyway. AWS's answer is [static stability](https://aws.amazon.com/builders-library/static-stability-using-availability-zones/): run enough capacity before the outage that no new instance is needed, "when we use three Availability Zones, we overprovision by 50 percent".

## Decision

- **Zones on components** (`zones`, 1 to 3, 1 by default). A component the design runs itself spreads its instances over that many zones. They are numbered shard by shard and dealt over the zones in turn, as providers balance them: each shard's replicas land in different zones first, and every zone holds as many instances as the others, give or take one. A component cannot use more zones than it has instances. Managed offerings (ALB, DynamoDB, SQS, the external APIs) span zones on their own. In-process components live in their service's instances, and clients are outside the region.
- **A lost zone** (`zone-down`, a fault with no target) takes every instance in the zone, in every component. For each component, the zone lost is the one that hurts it most: the most shards left without their keys, then the most instances.
  - **Fleets** lose that zone's share of their instances; the rest carry the load.
  - **Stores with a primary** keep their writes: the replica in another zone has been promoted. A store whose replicas all shared the zone loses everything.
  - **Shards with one instance** lose the keys of the shards that were in the zone (Memcached keeps one copy of each key).
  - **Quorum stores** (`quorum` on a kind: etcd and Cassandra, which read and write at a majority) stop when the zone held a majority of each shard's replicas. Three replicas over two zones put two in one of them. The same rule now applies to a lost node: a store of two replicas loses its majority with one.
- **Static stability.** An environment that loses a zone runs autoscaled components at the whole instances they ran for the same load before the outage, and the zone takes its share of those. The autoscaler starts nothing in their place. A timeline is different: there the autoscaler launches replacements after its usual window and startup time, which is what recovery looks like.
- **The check.** `no-single-point-of-failure` takes `scope: zone`. Everything that runs entirely in the lost zone goes at once, so every kind of request needs a successful path that survives all of it together: a cache with the database behind it is no fallback when both share the zone. The finding names the lost components those requests use, and why each is lost. Capacity is left to the environment's metric checks.
- **Shown.**
  - The inspector has a Zones control for the components a design places, and says what losing a zone does.
  - Nodes show their zones (`×25 · 3 AZ`).
  - A fault that fails or slows calls shows red; one that only costs instances shows amber, and becomes evidence for a failed check only when the instances left are overloaded.

## Consequences in the corpus

- **S6 loses a zone.** The URL shortener's dependency-failure scenario gets a third environment, the peak with a zone lost. Its checks:
  - redirects and creates must not depend on one zone (`redirects-zone-redundant` is a gate);
  - redirects must stay at 99.9% (critical);
  - their p99 must stay under 50 ms.
- **The goldens spread over three zones and keep a third spare.**
  - The autoscaled services scale to 60% instead of 70%, so that two zones carry the peak at 90%.
  - The fixed fleets grew: NGINX from 8 to 12 instances, the redirect servers from 25 to 33.
  - Every score they are expected to reach still holds, within the S3 budgets. The S5 scores of the designs expected not to pass it rise by a point.
- **Memcached does not survive a lost zone.** Its shards have one instance each, so a lost zone takes a third of the cache, and the misses overload the MySQL behind it. The MySQL and Memcached golden scores 79 in S6, capped by the critical check, and is no longer expected to reach 90.
- **Six mutants keep the lesson.** They put redirect servers, the database or the cache in one zone, scale to 70%, size a fixed fleet without a zone to spare, or spread etcd over two zones. All 131 mutants are caught.

## Known gaps

- **Failovers are instant.** The environment is the state after the failover. Timelines still set when a failover ends; failover times from the catalog come next: RDS Multi-AZ fails over in [60 to 120 seconds](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html), a Multi-AZ DB cluster in [under 35](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/multi-az-db-clusters-concepts-failover.html), and ElastiCache [in seconds](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/AutoFailover.html).
- **Zones cost nothing yet.** Every hop takes the region's round trip, and data crossing zones, [$0.01 a GB in each direction](https://aws.amazon.com/blogs/networking-and-content-delivery/exploring-data-transfer-costs-for-classic-and-application-load-balancers), is not billed. Zone-aware routing, which keeps calls in their zone, is not modelled either.
- **Each component loses its worst zone.** Placement is not shared between components, so the loss is the worst case for each of them at once.
- **In timelines, a lost zone keeps its share of new instances.** Replacements the autoscaler launches lose the zone's share of their capacity too, although they would start in the zones left. And a cache that lost some of its shards with a zone keeps the rest warm when the zone returns, but the lost shards do not come back empty: only a cache that lost everything starts cold.
- **Managed services carry on untouched**, although they lose their nodes in the zone for a moment.
- **Lost instances are still billed** in the environment that loses them.
- **A zone fails whole.** Partial impairments (a slow zone, packet loss between two zones) are not modelled.
- **Only the URL shortener loses a zone.** A chat service losing a zone's WebSockets, and the reconnect storm that follows, is a lesson for later.
