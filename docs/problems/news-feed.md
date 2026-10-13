# Problem design: News Feed

The third problem pack. Its lesson is the trade between work at write time and work at read time: copying every post into its followers' timelines keeps reads cheap until an account with tens of millions of followers posts.

## Brief

People post short updates and follow each other. The home timeline shows the newest posts from followed accounts, 20 a page, scrolling back. Most people follow and are followed by a few hundred accounts; a handful have tens of millions of followers. A new post reaches followers within seconds.

| Quantity | Value |
|---|---|
| Daily users | 200 million; 50 million active in any hour |
| Timeline reads | 150,000 /s on average, 300,000 /s at peak |
| New posts | 5,000 /s on average, 10,000 /s at peak |
| Follows | 200 followers and 200 followees on average; celebrities up to 50 million followers |

## Requirements

| ID | Requirement |
|---|---|
| FR-1 | Post an update |
| FR-2 | Home timeline: newest posts from followed accounts, 20 a page, no repeats or skips while scrolling |
| NFR-1 | Timeline p99 < 200 ms; posting p99 < 500 ms |
| NFR-2 | A new post reaches followers within 5 seconds |
| NFR-3 | Posting stays available (99.9%) even when timelines cannot be served |

## Model

- **Entities.**
  - `Post` and `AuthorPosts` (an account's recent posts) are durable.
  - `Timeline` is ephemeral (cached per user).
  - `CelebrityPosts` is ephemeral. It is hot for readers who follow celebrities (`hotFor: followsCelebrity`).
- **Counts.** `followers` (200 by default, 50 million for a celebrity), `followees` (200) and `celebritiesFollowed` (0 by default, 3 for many readers).
  - A fan-out step (`each: followers`) makes its call once per item, in parallel.
  - It can batch its own calls without waiting for other requests.
- **Logic.** `isCelebrity`, decided by the `celebrity` fact.
- **Decision.** `pagination`: offset or cursor.

## Scenarios

### S1: Home timeline
Average day and peak.
- **Gate:** new posts reach timelines (something consumes `post-created`).
- **Checks:**
  - timeline p99 under 200 ms and posting p99 under 500 ms;
  - fan-out lag under 5 s, and the fan-out keeps up;
  - nothing above 85%;
  - 90% of timeline reads from the cache;
  - cursor pagination;
  - an average day under $60,000.
- **Signal:** batched timeline writes.

### S2: Celebrities
Celebrities post 20 times a second; half the readers follow three of them.
- **Checks:**
  - the fan-out keeps up, with posts reaching timelines within 5 s;
  - timeline p99 under 200 ms with celebrities merged in;
  - nothing above 85%, although every fan looks up the same few celebrity entries.
- **Signal:** celebrity posts merged at read time, not copied.

### S3: Timelines lost
The timeline cache is down at peak.
- **Gate:** posting keeps 99.9%.
- **Checks:**
  - nothing above 90%, so rebuilds are capped;
  - cache calls time out within 50 ms.
- **Signal:** a circuit breaker on the cache.

## Corpus

| ID | Design | Scenarios |
|---|---|---|
| `hybrid-fan-out` | Post service → Cassandra and Kafka. A Flink job copies posts to followers' Redis timelines in batches of 100 and keeps celebrities' posts in one entry each. The timeline service reads Redis and merges celebrities from an in-process cache. Rebuilds read followed accounts in batches of 50 behind a bulkhead. | S1, S2, S3 |
| `push-postgres` | The same with PostgreSQL, copying every post, celebrities included. | S1, S3 |

Ten mutants cover:
- the read path: pulling on every read, and a small timeline cache;
- the write path: posts not published, posts not fanned out, and unbatched writes;
- offset pagination;
- celebrities: their posts pushed, and their entries read from the shared cache;
- the outage: unbounded rebuilds, and a slow cache timeout.

## Estimates

The pack asks:
- posts a day (432 million);
- fan-out writes at peak (2 million/s);
- the time to copy one post to 50 million followers (50 s);
- memory for 50 million timelines (320 GB);
- what pulling every timeline would cost (60 million reads/s).
