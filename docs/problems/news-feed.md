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
| Photos | 1 post in 20 carries one, 200 KB; a timeline page shows about one; about 8 billion kept |

## Requirements

| ID | Requirement |
|---|---|
| FR-1 | Post an update |
| FR-2 | Home timeline: newest posts from followed accounts, 20 a page, no repeats or skips while scrolling |
| NFR-1 | Timeline p99 < 200 ms; posting p99 < 500 ms |
| NFR-2 | A new post reaches followers within 5 seconds |
| NFR-3 | Posting stays available (99.9%) even when timelines cannot be served |
| FR-3 | Attach a photo to a post, and see it with the post in timelines |
| NFR-4 | A photo loads in under 300 ms (p99) |
| NFR-5 | Only signed-in users upload photos, each under the key the service gave them |

## Model

- **Entities.**
  - `Post` and `AuthorPosts` (an account's recent posts) are durable.
  - `Timeline` is ephemeral (cached per user).
  - `CelebrityPosts` is ephemeral. It is hot for readers who follow celebrities (`hotFor: followsCelebrity`).
  - `Photo` is 200 KB and durable.
- **Photo operations.** `start-upload` answers with a key and an upload URL; `upload-photo` and `read-photo` carry the photo. Object storage can handle the last two itself ([ADR 0021](../adr/0021-object-storage.md)).
- **Counts.** `followers` (200 by default, 50 million for a celebrity), `followees` (200) and `celebritiesFollowed` (0 by default, 3 for many readers).
  - A fan-out step (`each: followers`) makes its call once per item, in parallel.
  - It can batch its own calls without waiting for other requests.
- **Logic.** `isCelebrity`, decided by the `celebrity` fact, and `signUpload`, which signs an upload URL.
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
  - an average day under $182,500 ($122,000 of it is sending the timelines).
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

### S4: Photos
Average day and peak, with the feed's own traffic and 300,000 photo reads a second at peak. `start-upload` is optional.
- **Gates:** only signed URLs upload; photos are kept in durable storage; 99% of photos load at peak.
- **Checks:**
  - photo p99 under 300 ms;
  - nothing above 85%, prefixes included;
  - an average day under $4.35 million (sending 79 PB of photos a month is about $4 million of it).
- **Signals:** photos, and uploads, go straight between clients and object storage.

## Corpus

| ID | Design | Scenarios |
|---|---|---|
| `hybrid-fan-out` | Post service → Cassandra and Kafka. A Flink job copies posts to followers' Redis timelines in batches of 100 and keeps celebrities' posts in one entry each. The timeline service reads Redis and merges celebrities from an in-process cache. Rebuilds read followed accounts in batches of 50 behind a bulkhead. Photos live in S3 over 70 prefixes; the post service signs uploads, and S3 answers uploads and reads itself. | S1, S2, S3, S4 |
| `push-postgres` | The same with PostgreSQL, copying every post, celebrities included. | S1, S3, S4 |

Seventeen mutants cover:
- the read path: pulling on every read, and a small timeline cache;
- the write path: posts not published, posts not fanned out, and unbatched writes;
- offset pagination;
- celebrities: their posts pushed, their entries read from the shared cache, and a timeline service capped below what merging them needs;
- the outage: unbounded rebuilds, and a slow cache timeout;
- photos: relayed through the timeline service, uploads relayed through the post service, unsigned upload URLs, photos bound to nothing, and too few prefixes (16, and 60).

Reading celebrities' entries from the shared cache, without the in-process copy, is caught by the network, not the CPU. A Redis node serves about 400,000 commands a second, as ElastiCache measures it, so the shard holding the celebrities and its replica could take every fan's lookups. Each lookup returns a 1.6 KB list, though: 450,000 a second is about 5.8 Gbps, and the shard's two nodes sustain 2.5 Gbps each (M21's work units). For one part of M21, between calibration and bandwidth, the mutant was gone.

## Estimates

The pack asks:
- posts a day (432 million);
- fan-out writes at peak (2 million/s);
- the time to copy one post to 50 million followers (50 s);
- memory for 50 million timelines (320 GB);
- what pulling every timeline would cost (60 million reads/s).
