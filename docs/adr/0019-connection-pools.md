# ADR 0019 — Connection pools and connection limits

**Status:** accepted · 2026-10-17 · builds on [ADR 0010](0010-calibrated-against-published-benchmarks.md) and [ADR 0011](0011-request-units-and-bandwidth.md)

## Context

Until now, a component's limits were requests, bytes and held client connections ([ADR 0011](0011-request-units-and-bandwidth.md)). A relational database has one more limit, and its callers have one of their own:
- **A connection runs one statement at a time.**
  - PostgreSQL serves each connection with a process of its own, and MySQL with a thread.
  - A caller therefore reaches the database through a pool of connections, and each of its instances keeps its own.
  - A pool holds as many calls as it has connections. By Little's law, the calls in flight are calls a second × their latency.
  - [HikariCP](https://github.com/brettwooldridge/HikariCP) defaults to 10 connections and makes a caller wait up to 30 seconds (`connectionTimeout`) for a free one. [node-postgres](https://node-postgres.com/apis/pool) also defaults to 10, and waits without a limit.
- **The database accepts only so many connections.** RDS sets `max_connections` from the instance's memory ([quotas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html#RDS_Limits.MaxConnections)):
  - PostgreSQL: `LEAST({DBInstanceClassMemory/9531392}, 5000)`.
  - MySQL: `{DBInstanceClassMemory/12582880}`.
  - DBInstanceClassMemory is what is left after the operating system and the RDS processes. AWS's own example leaves 630 MySQL connections instead of 683 on 8 GiB, which is 92.3% of the memory.
  - Every instance an autoscaler adds opens its pools. The connections grow with the fleet, not with the database.
- **The managed fix.** [RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-best-practices.usage-scenarios.html) pools and multiplexes: "the number of containers multiplied by the size of each container mini-pool can potentially exceed connection limits", and the proxy brings "the number of back-end database connections down to a manageable level".
  - AWS says it typically adds latency "in the low single-digit milliseconds".
  - The Price List API (published 2026-10-06) bills it $0.015 an hour per vCPU of the instances behind it.

## Decision

- **Which stores pool.** A kind can be `pooledConnections`; the relational database is.
  - Redis, DynamoDB and Cassandra serve many calls over each connection and are not pooled.
  - Their sizes give `maxConnections` and `vcpus`:

    | Size | max_connections | vCPUs |
    |---|---|---|
    | PostgreSQL s (db.m6i.large, 8 GiB) | 831 | 2 |
    | PostgreSQL m (db.m6i.2xlarge, 32 GiB) | 3,326 | 8 |
    | PostgreSQL l (db.m6i.4xlarge, 64 GiB) | 5,000 (the cap) | 16 |
    | MySQL m (db.m6i.2xlarge, 32 GiB) | 2,520 | 8 |

- **A pool per copy.** Every caller instance keeps `poolSize` connections to each copy it calls. The pool size is set on the connection's policy and defaults to 10.
  - A caller that reads from replicas pools to all of each shard's copies.
  - One that only writes, or reads consistently, pools to each shard's primary.
- **How full a pool is.**
  - Statements in flight per instance = calls a second per instance × how long a call holds its connection.
  - The hold time is the store's latency, the round trip, and the proxy's hop when there is one. It is capped at the store's latency just short of saturation, since the pools themselves keep its queue from growing without end.
  - Each pool is a queue with `poolSize` servers. Calls that get a connection wait for it (Erlang C).
  - Beyond the pool, the share 1 − 1/ρ of attempts finds none free. They wait for the caller's timeout (or 30 seconds, HikariCP's) and fail without reaching the store.
  - A circuit breaker counts these failures, as Resilience4j counts HikariCP's exception.
- **How full the store is.**
  - Every caller pools to each shard's primary, so the primary holds Σ instances × pool size.
  - Beyond `maxConnections`, the share 1 − 1/ρ of its requests is refused, like any overload.
  - Open connections take memory, not time, so the statements it serves do not queue behind them. A WebSocket gateway's held client connections still add to its queueing, as before.
  - Only the instances a fault leaves running hold pools and share the calls.
- **A proxy** (`proxy: true` on the store, for flavors with `connectionProxy`).
  - The callers' pools connect to the proxy, which opens a database connection only while a statement runs. The pools no longer count against the limit.
  - Every call pays the proxy's 2 ms.
  - It costs `pricePerVcpuHour` × vCPUs × instances behind it (`costBreakdown.proxy`).
- **Metrics.**
  - `EnvironmentMetrics.pools`, per pooled connection: pool size, copies, caller instances, hold time, in flight, utilisation, wait, the share exhausted, and whether a proxy holds it.
  - `ComponentMetrics.connections`: open connections on the fullest instance, and the limit.
- **The check** (`connection-pools(environment, maxUtilization = 0.8)`).
  - It fails when a store would hold more connections than it accepts, or when a pool runs out. Its findings show the sums: instances × pool size per caller, and calls a second × hold time = in flight.
  - A pool above `maxUtilization` gets partial credit.

## Consequences in the corpus

- **No golden moved.** Every score, cost and p99 matches main, apart from 0.1 ms in two scenarios they are not meant to pass.
  - With a pool of 10 to each copy, the busiest pool is 57% full when S4's cache is down.
  - The largest fleet holds 1,110 of PostgreSQL's 5,000 connections at S5's spike.
- **S4 gains `pools-without-the-cache`** (major, availability) in the cache-down environment.
- **S5 gains `connections-at-spike`** (critical, scalability) at the spike.
- **Two mutants**, 143 in all, every one caught:
  - `big-pools-on-an-autoscaled-fleet`: 50 connections a copy. At the spike, 105 redirect instances × 50 + 3 × 10 + 3 × 10 = 5,310 connections on each primary, over 5,000. S5 fails `connections-at-spike` and `spike-availability`.
  - `pools-sized-for-a-warm-cache`: 4 connections a copy on the fixed fleet. With the cache down, 9,091 calls a second per instance × 2.5 ms = 22.7 in flight on 16 connections, 142% busy, and 30% of the database calls wait until they give up. S4 fails `pools-without-the-cache`.
- **RDS Proxy fixes the first mutant.** S5 is back at 100 for $701 a month (16 vCPUs × 4 instances), and the spike's redirect p99 goes from 9.7 to 11.8 ms.

## Known gaps

- **Pools are always full-size.** HikariCP's `minimumIdle` defaults to its maximum, so every connection opens at start. Pools that grow on demand would hold fewer at quiet times.
- **One pool per copy.** A single reader pool behind a reader endpoint would give a caller fewer connections to replicas.
- **A hot key's shard fills its pools first.** Calls are taken to spread evenly over the copies.
- **A hanging store holds connections only through its latency.** The engine's fault model fails hung calls separately, so a hung database does not fill the pools in the model.
- **The proxy's own limits are not modelled.** Neither are its pinning, its 120-second borrow timeout, or its faster failover.
- **A call holds its connection for a flat 0.5 ms round trip** on top of the store's latency, whatever the zones.
- **Connections a second are not modelled.** Opening a connection costs the database work: churn from short-lived connections (Lambda) is what RDS Proxy is most often for.
