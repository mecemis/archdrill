# ADR 0014 — Failover times from the catalog

**Status:** accepted · 2026-10-16 · builds on [ADR 0008](0008-time-stepped-timelines-instead-of-per-request-des.md) and [ADR 0013](0013-availability-zones.md)

## Context

How long writes fail when a database loses its primary was the scenario's choice: S6's timeline ended the failover at 75 s, 45 seconds after it began, whatever the store. Real stores publish what it takes. An RDS Multi-AZ DB cluster, a writer and two readers that serve reads and take over by themselves, fails over in [typically under 35 seconds](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/multi-az-db-clusters-concepts-failover.html). A Multi-AZ DB instance, whose one standby serves no reads, takes [60 to 120](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html). DynamoDB fails over without the caller noticing. How long creates fail, the recovery time objective a design can promise, depends on the store chosen.

A lost zone also takes the primaries that were in it. Part 1 showed the state after they had failed over; a timeline should show the failover itself.

## Decision

- **`failoverSec` on a flavor**: seconds from losing a primary until a replica takes writes again, for stores whose writes go to a primary. PostgreSQL and MySQL take 35, published for the Multi-AZ DB cluster, which is what replicas that serve reads and take over by themselves stand for. Managed stores fail over unseen. Stores without a primary have none to replace: Cassandra, which reads and writes at a quorum of replicas, now counts as one of them.
- **Failovers in timelines last as long as the store's.** A `failover` fault event without `until` ends, for each store it hits, once that store's failover time has passed, and the timeline closes the fault there. A store with no replica to promote stays down to the end, as does one whose flavor gives no failover time. An event with `until` keeps its end.
- **A lost zone fails over its primaries.** In a timeline, writes to the shards whose primary was in the lost zone fail for the store's failover time; after that, a replica in another zone has taken over and only the zone's instances are missing. The timeline marks when each store has failed over ("Links DB failed over"); a store that lost every replica with the zone does not. The steady-state environment stays the moment after the failover.
- **Primaries spread over the zones.** Part 1 dealt instances over the zones shard after shard, which put every shard's primary in one zone when a shard had as many replicas as there were zones. Each shard's replicas now start one zone further than the shard before, so primaries move round the zones, as providers balance them. The zones still hold as many instances as each other, give or take one.
- **Shown.** The inspector lists a store's failover time with its source.

## Consequences in the corpus

- **S6's failover timeline ends with the store.** The PostgreSQL goldens fail over in 35 s instead of the 45 the scenario chose; the DynamoDB goldens never notice. `creates-recover-after-failover` now asks for creates back within 45 seconds of losing the primary: the store's failover time plus at most ten seconds to clear what piled up.
- **S6 loses a zone second by second.** A new timeline loses a zone at 30 s of the peak, for good. Its checks:
  - redirects stay at 99.9% throughout, before any replacement has started (`redirects-through-zone-loss`, critical);
  - creates are back within 45 seconds (`creates-back-after-zone-loss`).
- **Two predictions** come with it: what happens to creates (half fail for 35 s in the PostgreSQL goldens, none in the DynamoDB ones, all of them for good with the database in one zone), and to redirects before replacements start.
- **The click pipeline rides it too.** In the PostgreSQL golden, Flink counted clicks at 70% on four to sixteen instances. Losing a zone pushed it past capacity until replacements started two minutes later, and redelivered clicks piled up meanwhile. It now scales to 60% from six instances.
- **Scores.** Every golden keeps its scores. The zone mutants now also fail the timeline's checks, and all 131 are caught.

## Known gaps

- **One way to fail over per store.** A Multi-AZ DB instance (60 to 120 s), a read replica promoted by hand, or Aurora's faster failover would each be a choice with its own price and recovery time; the catalog offers the cluster only.
- **Clients notice late.** A failover changes a DNS name, and a client that caches it longer than its TTL keeps calling the old primary; AWS [advises](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html) a JVM to cache it for no more than 60 seconds. The engine assumes callers follow at once.
- **Caches and coordination services have no failover time.** ElastiCache promotes a replica ["typically just a few seconds"](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/AutoFailover.html) after its primary fails, and etcd elects a leader after its [one-second election timeout](https://etcd.io/docs/v3.5/tuning/); neither holds a design's data here, so the engine treats their failover as immediate.
- **Health checks are instant.** A load balancer stops sending to the lost zone's instances at once. ALB's [default health check](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html) (every 30 seconds, out after two failures) takes about a minute to notice.
