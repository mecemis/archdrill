# ADR 0015 — Traffic between zones

**Status:** accepted · 2026-10-16 · builds on [ADR 0011](0011-work-units-and-bandwidth.md) and [ADR 0013](0013-availability-zones.md)

## Context

Since ADR 0013 a design places its instances in zones, but every hop still took the same half millisecond, and data crossing zones was free. Neither holds in a real region:

- **Latency.** A round trip between two instances in the same zone is "typically sub-millisecond" with enhanced networking; AWS counts "1 ms as the minimum network latency added for each AZ traversal" ([Availability Zone affinity](https://aws.amazon.com/blogs/architecture/improving-performance-and-reducing-cost-using-availability-zone-affinity/), AWS Architecture Blog, 2021, updated 2025).
- **Price.** Data that crosses zones is billed [$0.01 a GB in each direction](https://aws.amazon.com/blogs/networking-and-content-delivery/exploring-data-transfer-costs-for-classic-and-application-load-balancers): the EC2 instance that sends it pays for it leaving, the one that receives it for it arriving. What sits at each end decides who pays:
  - RDS charges nothing for data [in and out of the database instance](https://aws.amazon.com/rds/pricing/), and replication between a Multi-AZ deployment's zones is free; the EC2 end still pays.
  - ElastiCache charges nothing [at the node](https://aws.amazon.com/elasticache/pricing/); the application pays its side.
  - An Application Load Balancer [does not charge](https://aws.amazon.com/elasticloadbalancing/faqs/) for the data its cross-zone load balancing moves.
  - AWS services reached at their regional endpoints, such as DynamoDB and SQS, carry [no data transfer charge](https://aws.amazon.com/blogs/architecture/overview-of-data-transfer-costs-for-common-architectures/).
- **Routing.** A fleet spread over three zones that calls another spread the same way sends two calls in three to another zone. In AWS's own example, a request crossed zones up to eight times; keeping calls in their zone halved that and cut transfer costs by about 40 percent.

## Decision

- **Round trips by zone.** A hop between two components the design places takes 0.1 ms within a zone and 1 ms between zones, weighted by the share of its calls that cross. A client's hop into the region keeps 0.5 ms, as does a call to a regional service (DynamoDB, SQS, an external API): where its endpoints answer from is the service's to decide, and it bills no transfer.
- **Replicas by zone.** A write waits for the nearest replica's round trip under semi-synchronous replication, and for the farthest one's (and its disk) under synchronous replication, from where the replicas are placed. A store in one zone acknowledges within 0.1 ms, and loses its replicas with the zone.
- **Where calls go.** A read goes to any instance of the target, or of the key's shard. A write goes to its shard's primary, and a message to its partition's leader. A managed load balancer has a node in each zone its targets use, and in at least two: an Application Load Balancer [needs two zones](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html), so half of what it sends to targets in one zone crosses. Timelines follow the instances an autoscaled fleet runs at each step.
- **Zone-aware routing** (`sameZone` on a connection's policy). Each zone keeps what the target's instances there can take at an even load, and sends the rest to other zones, as Envoy's zone-aware routing does. A target group without cross-zone load balancing and Kubernetes' `PreferClose` do the same where the zones are balanced.
  - Reads move to a replica in the caller's zone: ElastiCache replicas, database readers, a Kafka follower ([KIP-392](https://cwiki.apache.org/confluence/display/KAFKA/KIP-392%3A+Allow+consumers+to+fetch+from+closest+replica)).
  - Writes to a primary or a leader cannot move.
- **Bytes.** On the way in, a hop carries the request and its response, or the message a consumer receives. A call carries its item: the value a read returns, or what a write or a message sends. Keys and headers are left out.
  - An event can state its message's size (`bytes`) when it carries less than its entity. The URL shortener's click message is 100 bytes, a code and a time, not the 500-byte link.
- **Who pays** (`crossZoneBilling` on a flavor).
  - `each-end`: the instances a design runs on EC2 (services, NGINX, Kong, Kafka on MSK, Flink, Cassandra, etcd) pay for what they send and receive across zones.
  - `other-end`: RDS (PostgreSQL, MySQL) and ElastiCache (Redis, Memcached) pay nothing at their end.
  - `free`: nothing is billed on a hop through an Application Load Balancer, or to DynamoDB or SQS.
  - A hop costs $0.01 a GB for each end that pays, and nothing when either end is free. The component making the calls carries the cost, both ends' share.
- **The check.** `zone-local-calls` finds the connections that pay more than a set amount a month for crossings that zone-aware routing would avoid, and names the saving on each.
- **Shown.**
  - A connection inspector section, Zones, turns zone-aware routing on and shows, at the selected environment:
    - the share of calls that cross;
    - the round trip;
    - the data a month and what it costs;
    - what routing would save.
  - Component and total costs show the part spent between zones.
  - The catalog panel shows who pays at each flavor's end, with its source.

## Consequences in the corpus

- **Latency.** Hops between components in one zone take 0.1 ms instead of 0.5, though a load balancer keeps a node in a second zone; designs spread over three zones without routing pay 0.7 ms a hop. Every p99 check holds.
- **The URL shortener's goldens route within their zones.** NGINX sends to the services in its zone, services read Redis and the database from replicas in theirs, and the click counter reads Kafka in its zone. At S3's average load:

  | Golden | Monthly cost | Of it, between zones |
  |---|---|---|
  | `postgres-redis-cache-aside` | $36,999 | $1,001 |
  | `dynamodb-redis-cache-aside` | $29,752 | $482 |
  | `postgres-redis-fixed-fleet` | $35,030 | $602 |

  Without routing on the NGINX hop alone, two thirds of its 157 TB a month cross zones, about $3,100 a month, and the Postgres golden's average day in S5 goes over budget.
- **The MySQL and Memcached golden no longer passes S3.** A key's one copy is in one zone, so two cache reads in three cross zones whatever the routing. With $870 a month of cache traffic, the design costs $40,947, just over S3's $40,000. Redis replicas read in the caller's zone avoid it.
- **S3 gains `zone-local-calls`** (senior signal), with two mutants: proxies that spread redirects over every zone, and cache reads from any replica. 133 mutants, every one caught.

## Known gaps

- **Routing ignores a lost zone.** The shares that cross come from the full placement; a lost zone takes instances but does not change them.
- **Replication is free.** RDS, ElastiCache and MSK do not bill it, but a self-managed Cassandra or Kafka on EC2 pays for every replica in another zone, and the engine bills none of it.
- **Zone-aware routing never overloads a zone.** Real `PreferClose` keeps traffic local even when a zone's endpoints are too few for it; the engine spills over evenly, as Envoy does.
- **Payloads are bare.** Keys, headers and TLS framing are not counted, and compression (a Kafka producer's batches, for one) is not modelled.
- **Regional services keep the region's round trip.** Where DynamoDB's or SQS's endpoints answer a caller from is not modelled; their calls take 0.5 ms, as every hop did before.
- **Other transfer is not priced.** NAT gateway processing, data out to the internet, a managed API gateway's private integrations, and traffic between regions.
