# ADR 0020 — Memory and disk

**Status:** accepted · 2026-10-24 · builds on [ADR 0010](0010-calibrated-against-published-benchmarks.md) and [ADR 0019](0019-connection-pools.md)

## Context

The catalog's relational database capacity was measured with the data in memory: pgbench reads a few small tables over and over ([ADR 0010](0010-calibrated-against-published-benchmarks.md)). A real store holds far more than its memory:
- **It caches pages, not rows.** PostgreSQL and InnoDB keep recently used pages of their tables and indexes in memory, and read the rest from disk.
  - RDS for PostgreSQL sets `shared_buffers` to `{DBInstanceClassMemory/32768}` 8 KB pages, a quarter of the instance's memory ([memory](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Tuning.concepts.memory.html), [units](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Parameters.html)). PostgreSQL reads through the operating system's page cache, which holds most of the rest.
  - RDS for MySQL sets `innodb_buffer_pool_size` to `{DBInstanceClassMemory*3/4}`, and InnoDB bypasses the operating system's cache ([AWS Database Blog](https://aws.amazon.com/blogs/database/best-practices-for-configuring-parameters-for-amazon-rds-for-mysql-part-1-parameters-related-to-performance/)).
- **The disk has a rate.** RDS stores data on EBS ([storage](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html)):
  - gp3 gives 3,000 I/Os a second below 400 GiB. From 400 GiB, RDS stripes four volumes and gives 12,000, provisionable from 12,000 to 64,000.
  - AWS gives gp3 "single-digit millisecond" latency 99% of the time, and io2 Block Express "sub-millisecond".
  - The instance has a limit of its own, "enforced at the DB instance level": m6i.large sustains 3,600 I/Os a second, m6i.2xlarge 12,000 and m6i.4xlarge 20,000, bursting to 40,000 for 30 minutes a day ([EBS-optimized instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ebs-optimized.html)).
  - The Price List API (published 2026-10-20) bills gp3 at $0.115 a GB-month and $0.02 an I/O a second a month above what the volume includes.
- **A cache in front changes what reaches the store.** It keeps the popular keys. The store sees what it misses, the long tail, which a page cache much smaller than that cache barely holds.
  - In the URL shortener, Redis holds about 110 million links, and a 64 GiB PostgreSQL copy's page cache 2.9 million keys.
  - Behind Redis, that page cache answers about 1% of reads. With the whole cache gone, reads come straight, and it answers three quarters of them.

## Decision

- **Which stores.** A flavor can have a `pageCache` and a `storageVolume`; PostgreSQL and MySQL have both.
  - DynamoDB (managed, priced per request) and Cassandra are unchanged.
  - So is any store that holds no data the problem gives a size for (news feed, payments): it is taken to fit in memory, as before.
- **Memory.** Sizes have `memoryGb` from the Price List API (8, 32 and 64 GiB).
  - What caches pages is three quarters of DBInstanceClassMemory, taken at 92.3% of the memory as for `max_connections` ([ADR 0019](0019-connection-pools.md)): `memoryShare = 0.692` for both engines.
  - For PostgreSQL, that is the page cache: it holds what `shared_buffers` holds too, so a page in both counts once.
- **Pages a key.**
  - A PostgreSQL read by key touches an index leaf and a heap page, 8 KiB each. An InnoDB read by primary key touches one 16 KiB leaf of the clustered index, which holds the row. Both take 16 KiB of cache a key.
  - With random keys, a popular row's neighbours are seldom popular, so each key is taken to need pages of its own.
  - A write dirties one page, written back once (`pagesPerWrite = 1`), on every copy of its shard.
- **Which keys stay in memory.** Each copy caches its shard's keys, an LRU under Che's approximation, as caches already are.
  - Reads that came straight follow the workload's popularity.
  - Reads that missed caches on the way follow what is left after those caches: `cacheHitsByBucket` gives, per popularity bucket, the probability each cache answers. It is scaled to the hit ratio the fixed point has reached, which also counts warming and fills.
  - Propagation records each store's reads by the caches they missed (`storeReads`). The hot key's reads are left out: it stays in any cache.
  - The entities read from a store share its memory.
  - Inputs are rounded to four significant digits and memoised, as the cache model's are.
- **The volume.**
  - Each copy's data is the dataset over its shards, which gives the volume: 3,000 I/Os a second, or 12,000 from 400 GiB.
  - `iops` on the component provisions 12,000 to 64,000, takes a striped volume (at least 400 GiB billed), and costs $0.02 an I/O a month above 12,000, every copy.
  - A copy sustains the fewer of its volume's I/Os and its instance's `ebsIops`.
- **In the fixed point.**
  - `relaxStorage` relaxes, per store, the share of reads its page cache answers and the I/Os a read takes. A miss reads `pagesPerRead` pages.
  - The volume's share, `(reads × ioPerRead + writes × ioPerWrite) / (iopsPerCopy × instances)`, joins CPU, network and connections in `utilizationOf`: whichever is fullest limits the store.
  - Beyond 1, the share `1 − 1/ρ` is refused like any overload. A hot key's reads take no I/O, and its writes land on one shard.
  - A consistent read is the primary's alone: its I/O is weighted as its load is.
- **Latency.** A read that misses waits for its pages: each takes `readMs` = 1 ms on an idle volume, at the fast end of gp3's "single-digit millisecond" (a third party measured 1.67 ms on average under heavy OLTP load), plus an M/D/1 wait at the copy's volume utilisation.
- **Metrics and findings.**
  - `ComponentMetrics.disk` gives the hit ratio, read and write I/Os a second on one copy, the copy's limit, and the busiest shard's volume utilisation.
  - `costBreakdown.iops` gives what is provisioned above the striped volume.
  - The headroom check says when the volume is what fills up: the page cache's hit ratio, and the I/Os a copy needs against what it sustains.

## Consequences in the corpus

Only the URL shortener's PostgreSQL goldens moved; its MySQL and hash-based goldens, every other problem, and every DynamoDB golden are unchanged.
- **The cache-aside goldens read the long tail from disk.**
  - At S2's peak, 29,700 reads a second reach `postgres-redis-cache-aside`'s database behind the near cache and Redis. Its page cache answers 2.3% of them.
  - With 2 shards × 2 replicas that is about 14,700 I/Os a second a copy, over the striped volume's 12,000.
  - At S5's viral spike, 68,800 reads a second reach it.
- **Shards, not replicas, add I/Os cheaply.** A replica copies a shard's whole 40 TB; a shard halves what each copy holds.
  - **`postgres-redis-cache-aside`:** 5 shards × 2 replicas, 20,000 I/Os provisioned a copy (what m6i.4xlarge sustains). The spike's 14,200 I/Os a copy, reads and writes, are 71% of it.
  - **`postgres-redis-fixed-fleet`:** the same, so that two zones still carry the peak when one is lost.
  - **`postgres-redis-two-regions`:** 3 shards × 2 replicas, 20,000 I/Os a copy.
  - **`postgres-sized-for-cache-loss`:** keeps 4 shards × 3 replicas and provisions 16,000 I/Os a copy. With the whole cache gone its page cache answers 76% of 300,000 reads a second, and each copy takes 12,800 I/Os a second, 80% of its 16,000.
- **The budgets that assumed a database in memory move.** Links DB costs $30,165 a month instead of $22,328.
  - **S3:** $40,000 → $46,000. The cache-aside golden costs $44,837 at average traffic; the fixed fleet $42,867.
  - **S5:** $40,000 → $48,000. An average day of the cache-aside golden costs $47,028.
  - **S9:** $80,000 → $86,000. The two regions cost $80,522.
  - The lesson of S3 holds: a database tier that serves 300,000 reads a second without the cache still costs far more.
- **Mutants**, 101 in all, every one caught:
  - **`database-sized-for-memory` (new):** the cache-aside golden's database as it was, 2 shards × 2 replicas and no provisioned I/Os. S2 fails `no-overload-at-peak` and `headroom-at-peak` at the normal peak.
  - **`provisioned-iops-dropped` (new):** five shards on the striped volume's 12,000. The viral spike fails `hot-shard-headroom`.
  - **`consistent-reads-everywhere`:** now fails S5: the primaries' volumes alone read the spike's misses, and creates fail with them.
  - **`pools-sized-for-a-warm-cache`:** now 2 connections a copy (10 copies, 20 an instance). With the cache down, about 23 statements are in flight a redirect instance.
  - **`retry-storm`:** still fails `retries-bounded`. Its storm no longer cascades: a database sized for its disk serves the retried misses (74% busy with the whole cache down).
  - **`no-bulkhead` is retired.** On a database sized for its disk, a cache outage's misses fit (74% busy). The bulkhead it removed protects nothing S4 tests any more.

## Known gaps

- **io2 is not offered.** Its lower latency and higher limits ($0.125 a GB-month and $0.10 an I/O a month) would suit the spike, at five times gp3's price per I/O.
- **The connections' memory is not taken from the page cache.** Neither is PostgreSQL's double buffering beyond counting a page once.
- **Recent rows are not hotter on disk.** New links are both popular and stored together in recent heap pages; the model scatters every hot key, which overstates misses for reads that come straight. Behind a cache, the tail is scattered anyway.
- **Index pages are as cold as rows.** A leaf holds hundreds of keys and is hotter than any one of them; PostgreSQL's two pages a miss are an upper bound (about 1.85 in the URL shortener).
- **The WAL and checkpoints are not counted.** Commits write the log sequentially and group-commit; only each write's dirty page is.
- **Bursts are not modelled.** An instance's 30 minutes a day at 40,000 I/Os would carry a short spike.
- **Throughput is not modelled.** 16 KiB reads at 20,000 a second are 312 MiB/s, within the striped volume's 500.
- **Reads of keys that do not exist** cost what reads of the tail do: their index pages.
- **A store's data with no size** in the problem is taken to fit in memory, and to write within any volume.
