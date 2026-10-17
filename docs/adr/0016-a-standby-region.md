# ADR 0016 — A standby region

**Status:** accepted · 2026-10-16 · builds on [ADR 0013](0013-availability-zones.md) and [ADR 0014](0014-failover-times.md)

## Context

Zones protect a design from losing a data centre, not from losing the region. A region can fail as a whole when something every zone shares breaks. On [20 October 2025](https://aws.amazon.com/message/101925/), a race condition in DynamoDB's DNS management left its regional endpoint in us-east-1 with an empty record. DynamoDB errors lasted from 11:48 PM to 2:40 AM PDT, and EC2 launches and the services that depend on them were impaired until 1:50 PM. A design that ran only there was down, however many zones it spanned.

AWS's [disaster recovery options](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html) range from backups restored in another region (hours) to active-active regions (near zero). In between are three active-passive strategies:
- **Pilot light:** data replicated, servers off.
- **Warm standby:** a scaled-down copy that scales up on failover.
- **Hot standby:** a full copy.

The steps of a failover set its recovery time:
- **Detection.** Route 53 [checks an endpoint](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-determining-health-of-endpoints.html) every 30 seconds (10 for a fee), and changes its status after [three consecutive failures](https://docs.aws.amazon.com/Route53/latest/APIReference/API_HealthCheckConfig.html) by default.
- **DNS.** Resolvers keep a load balancer's address for its [TTL of 60 seconds](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html).
- **Promotion.** Promoting an RDS read replica in the other region "takes a few minutes to complete and rebooting is part of the process" (the whitepaper). An Aurora global database promotes [in minutes](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html). A DynamoDB global table takes writes in every region already.
- **Scaling.** A standby that has to scale up depends on Auto Scaling, "a control plane activity", in a region taking all the traffic at once.

Cross-region replication is asynchronous. A primary acknowledges a write before the other region has it, so a lost region loses what was in flight: global tables replicate ["typically within a second or less"](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html). Data sent to another region is billed at the sender. The [AWS Price List](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/us-east-1/index.json) gives $0.02 a GB from us-east-1 to us-west-2 and $0.01 to us-east-2, with nothing charged on the way in.

## Decision

- **A standby copy** (`regions: 2` on a component). The component also runs in a second region (active-passive), which takes no traffic until the primary region is lost.
  - **Placement.** The standby copy is placed like the primary one: same shape, same zones.
  - **Fleets** run their minimum in standby: an autoscaled fleet's `replicas`, a fixed fleet's count.
  - **Stores** replicate to their copy asynchronously.
  - **Caches** start empty when traffic arrives, unless the flavor keeps the copy filled (`crossRegionReplication`: ElastiCache Global Datastore for Redis). An in-process cache starts empty in a standby service, whose instances never served a request.
  - **What stays out.** Clients, external APIs and in-process components are not in the region. Their standby setting is ignored, with a warning.
- **A lost region** (`region-down`, a fault with no target). Every component without a standby copy is gone. In an environment, the failover has settled: DNS has moved clients, stores are promoted, fleets have scaled, and the standby copies serve as the primary ones did.
  - A lost region stays lost: a timeline cannot end it, nor lose it twice, and neither can combine it with a lost zone, which would be in it. The schema rejects all three.
- **Over time** (in a timeline), from the moment the region is lost:
  - Everything fails until clients reach the standby region: 90 s of health checks and 60 s of DNS TTL, 150 s in all.
  - A standby store whose writes go to a primary takes reads from then on, and writes once promoted. Promotion starts when the health checks declare the region lost and takes `regionFailoverSec` from the catalog: three minutes for RDS PostgreSQL and MySQL. A DynamoDB global table needs none.
  - Standby fleets run their minimum from the moment the region is lost, and the autoscaler decides nothing until traffic arrives. Then it scales them up after its usual window and start-up time.
  - Caches nothing kept filled start empty when traffic arrives.
  - The timeline marks when clients reach the standby region and when each store is promoted.
- **Cost** (`costBreakdown.standbyRegion`). The standby copy's instances at their standby count, another copy of the stored data, and the writes a pay-per-request store applies in both regions (DynamoDB bills replicated writes like its own). Stores and caches kept filled also pay $0.02 a GB for what they replicate.
- **Checks.**
  - `no-single-point-of-failure` takes `scope: region`: each kind of request needs a successful path that survives losing everything without a standby copy.
  - `no-acknowledged-data-loss` knows a lost region. A store without a standby copy loses what it held. One with a copy loses the writes of the last second, the lag the engine assumes for asynchronous replication. A scenario accepts that loss with `maxLossSec`, its recovery point objective (RPO).
  - Recovery times are `timeline-recovers` checks on the scenario's timeline.
- **Shown.**
  - A Regions control in the inspector, with what the standby copy does for that component.
  - A "standby region" tag on nodes.
  - The standby region's cost on each component and in the total.
  - The catalog's promotion times and cross-region replication, with their sources.

## Consequences in the corpus

- **S9, Lose a region.** A new URL shortener scenario, NFR-7: redirects back within four minutes of losing the region, creates within five, and at most the last second of links lost.
  - Environments: an average day for the budget ($80,000 a month), and the peak with the primary region lost.
  - A timeline loses the region 30 s into the peak and keeps it lost, with two predictions on recovery time.
  - Checks:
    - redirects must not depend on the region (gate), and neither should creates;
    - the RPO;
    - the standby region carries the peak, at 99.9% and under 50 ms p99;
    - the two recovery times;
    - the budget.
  - A staff signal asks for redirects back as soon as clients arrive: a hot standby.
- **Every complete single-region golden scores 20 in S9**, stopped by the gate. Their other scores are unchanged.
- **Two new goldens** copy the Postgres and DynamoDB designs with a warm standby of every component. Each scores 100 in S9:

  | Golden | Average day (S9) | Of it, standby region | Redirects back | Creates back |
  |---|---|---|---|---|
  | `postgres-redis-two-regions` | $75,367 | $36,186 | 210 s | 270 s (promotion) |
  | `dynamodb-redis-two-regions` | $60,464 | $29,071 | 210 s | 210 s |

  Redirects come back 60 s after clients do, once the standby fleets have scaled up. The second copy of the stored links is most of the standby cost ($18,170 for PostgreSQL), so neither design passes S3's $40,000 budget: resilience to a region costs about as much again.
- **Four mutants**, 137 in all, every one caught: a database, NGINX or Redis without a standby copy, and a single-region DynamoDB table.
- **A fix on the way.** Conditional inserts (`store.insertIfAbsent`) now carry their item's bytes, so creates count in cross-zone and cross-region transfer. No golden's score moved.

## Known gaps

- **Active-passive only.** Both regions never take traffic at once. Active-active designs, users routed to their nearest region, and what concurrent writes in two regions do to unique codes (DynamoDB global tables reconcile by last writer wins) are for M23, replication and consistency.
- **The failover is automatic.** Health checks start it as soon as they fail. Many teams fail over by hand, to avoid the cost of a false alarm, and that adds the time it takes to decide.
- **One promotion time per flavor.** RDS gives no figure for promoting a cross-region replica beyond "a few minutes"; three is a choice. Aurora global databases, and DynamoDB's multi-region strong consistency (an RPO of zero, at a write latency), are not in the catalog.
- **Only stores and caches replicate.** A standby Kafka cluster or etcd starts empty: clicks waiting in the lost region are lost, and a standby etcd does not know which key ranges the lost one leased.
- **Clients obey the TTL.** Some cache DNS answers longer, and keep failing after 150 s.
- **The standby region costs the same in every environment**, including the one that loses the primary region, whose instances are still billed.
- **No failback.** A lost region never comes back within a timeline.
- **The settled environment has warm caches.** It shows what the standby region does once it has run for a while; how a cold standby cache loads the database right after the failover shows only in the timeline.
