# ADR 0017 — Reading your own writes

**Status:** accepted · 2026-10-17 · builds on [ADR 0011](0011-work-units-and-bandwidth.md)

## Context

A store's replicas add read capacity: the engine has always counted every replica as serving reads. It has also assumed every replica answers with the latest write, which is free consistency that real stores do not give.

- **RDS.** A Multi-AZ DB cluster [replicates semi-synchronously](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/multi-az-db-clusters-concepts.html): a write commits once one reader has received it, which "doesn't require acknowledgment that events have been fully executed and committed on *all* replicas". Readers lag, and flow control only steps in when the lag nears two minutes. Asynchronous replicas lag the same way, or worse.
- **DynamoDB.** [Reads are eventually consistent](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html) by default: they "might not reflect the results of a recently completed write operation". A strongly consistent read (`ConsistentRead`) sees every acknowledged write, and costs twice as much.

A URL shortener shows the classic consequence. Someone creates a link and opens it at once, to test it or to share it. The redirect misses the cache and reads a replica that has not applied the insert yet, so the brand-new link answers 404. With negative caching, that 404 is then served for the negative TTL, after the replica has long caught up.

Every URL shortener golden that redirects had this bug.

## Decision

- **Consistent reads** (`consistent: true` on a `store.read`). The read sees every acknowledged write, at a price that depends on the store:
  - where replicas serve reads, only the primary can serve it, so it weighs `replicas` times an ordinary read in the store's read capacity;
  - a quorum store (Cassandra) reads a majority: `⌊replicas / 2⌋ + 1` times;
  - a store that meters reads in units takes a full unit instead of half of one (DynamoDB's strongly consistent read).
- **Which stores lag.** An ordinary read can miss a write acknowledged moments ago:
  - on any DynamoDB-like managed store, whose reads are eventually consistent;
  - on a store with replicas, unless the design replicates synchronously. Synchronous replication is taken to mean every replica applies a write before it is acknowledged (PostgreSQL's `remote_apply`). Semi-synchronous replication waits for a replica to receive the write, not to apply it, so it does not count.
  - A store with one copy never lags.
- **The check** (`read-your-writes(writeOperation, readOperation, entity, decision)`). It is structural and judges creates: the inserts on every path the caller is told succeeded (2xx). It looks at every way the read can answer "not found" from a store the create fills. Each must be covered by one of:
  - a cache that every such create fills, and that the read looks in first;
  - a consistent read;
  - a store that cannot lag.

  A create that answers once it has published the entity, for a consumer to store later, has stored nothing yet: only the cache covers it, however the read is made.

  The check takes the cache as up. A fill or a lookup that fails is what a cache outage does, which S4 judges.

  A failure names the store and why it lags, and says how long a negative cache keeps the wrong answer. The lag is taken as one second, the asynchronous replication lag the engine already assumes.
- **Shown.** A "Consistent read" setting on store reads in the flow editor, and "consistent" on the step card.

## Consequences in the corpus

- **S2 gains `fresh-links-redirect`** (major): a link redirects the moment it is created.
- **Every golden that redirects failed it, and was fixed the way most teams would:**
  - The seven with a cache fill it with the new link once the create has stored it. That adds a cache write per create and a cache dependency to creates, whose failures are ignored.
  - `dynamodb-direct`, which has no cache, reads the table consistently, so its redirect reads cost twice as much.
- **No golden's score moved**, except `dynamodb-direct` in S9 (from 20 to 19), which it does not pass anyway.
- **Three mutants**, 140 in all, every one caught:
  - creates that stop filling the cache (S2);
  - DynamoDB reads left eventually consistent (S2);
  - every cache miss read consistently from the primary. Its read capacity halves, and when the cache goes, the database takes creates down with the redirects (S4's `no-cascade`).
- **`cache-never-populated` is now caught by its gate only.** A cache filled by creates counts as filled for every key (see below), so its hit ratio no longer drops.

## Known gaps

- **Stale reads are not simulated.** The check is structural. How often a read lands inside the lag, and how long the lag really is under load, are not modelled.
- **A cache filled only by writes counts as filled for every key.** That fits a feed that fan-out on write keeps current, but not links: priming fills new links, not the popular old ones.
- **Updates are not checked.** A disabled link can keep redirecting from a lagging replica, and FR-4's minute is shorter than the two minutes of lag flow control allows. Only creates are judged.
- **Consistent reads cost capacity, not latency or zone traffic.** A read from the primary takes as long as one from a replica, and zone-aware routing still counts it as a read any replica could serve.
- **The cache is taken as up.** During a cache outage, a link opened right after it is created reads a replica, and can still answer 404.
- **One region.** What strongly consistent reads and conditional writes mean across regions (DynamoDB's multi-Region strong consistency) is for M23's second part.
