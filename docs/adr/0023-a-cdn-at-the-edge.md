# ADR 0023 — A CDN at the edge

**Status:** accepted · 2026-10-25 · builds on [ADR 0021](0021-object-storage.md) and [ADR 0022](0022-data-sent-to-the-internet.md)

## Context

With photos in object storage ([ADR 0021](0021-object-storage.md)) and data sent to the internet billed ([ADR 0022](0022-data-sent-to-the-internet.md)), the news feed's photos cost about $4 million a month, nearly all of it for sending 79 PB from S3 at $0.05 a GB. Two lessons were missing:
- **A CDN halves that bill.** CloudFront sends data to clients for $0.085 a GB down to $0.02 beyond 5 PB, and data from an AWS origin to CloudFront is free (Price List, published 2026-10-19). Its HTTPS requests cost $1 a million, more than S3's $0.40, and it still comes out at about half.
- **One photo lives in one prefix.** S3 takes 5,500 reads a second per prefix. A celebrity's photo read 60,000 times a second sits under one key, so more prefixes do not help; an edge that keeps the photo does.
- **The facts.** CloudFront keeps an object for its TTL, a day by default when the origin sends no `Cache-Control`, and may evict one asked for rarely. It collapses requests for an object it is fetching into one. A distribution takes 250,000 requests a second and 150 Gbps by default, and AWS raises both on request.

## Decision

- **Where it sits.** A CDN is a component with the `edge-cache` capability on the way in: clients → CDN → origin (object storage, a load balancer). It is not the handler; the operation's flow is unchanged.
- **What it keeps.** Operations say whether their answer can be kept at the edge (`cacheableAtEdge`: the same for everyone, and never changing, as a photo). Only those are cached; any other request passes through.
- **Routes.** A request the edge can keep takes a route through a CDN when the design offers one; any other request takes a route around it. Photos are then read through the CDN while uploads still go straight to the bucket with their signed URLs. Designs without a CDN route as before.
- **The edge's cache.** One cache per CDN and entity, in the cache model the design's caches use: Che's approximation over the workload's popularity, a TTL of `edgeTtlSec` (CloudFront's default day), filled on every miss, and coalesced. It is taken to have room for everything it keeps, as if the regional edge caches pooled the edge locations' misses: the TTL alone limits it. A hot key stays at the edge.
- **In propagation.** At the CDN, each request class is answered with its hit ratio; the misses go on to the origin, their classes reweighted. The CDN's lookups and fills drive the cache's fixed point like any cache's.
- **In the results.** A hit waits for the hops up to the edge and for the edge itself (a few milliseconds, an assumption); a miss waits for the whole way. Success, rejections and latency mix the two.
- **A viral object at the origin.** Object storage that answers itself now loads a hot key's requests onto the one prefix that holds it, which refuses what it cannot take.
- **The bill.** $1 a million HTTPS requests, hits and misses alike, and data sent to clients at CloudFront's own tiers (`internetTransfer` on the flavor), priced on the month's total of every CDN, apart from the Region's.
- **Outside the Region.** A CDN's edge locations do not run in the design's Region: losing the Region does not take them.

## The viral photo scenario (news feed S5)

- **The workload.** S4's, with one read of a photo in five for one celebrity's photo: 60,000 a second at peak.
- **Checks.** 99% of photos load at peak (a gate), nothing above 85% (the viral photo's prefix included), half the photos in under 50 ms, and an average day under $2.5 million. A senior signal: photos come from a CDN's edge.
- **The goldens** read photos through CloudFront in front of the bucket, and upload straight to it.
  - They score 100 in S4 and S5. The edge answers 80% of photo reads on an average day and 86% at peak in S4, and 87% at peak in S5, the viral photo included.
  - Photos take 6 ms at the median and about 200 ms at p99, which the misses still set.
  - An average day costs about $2.26 million instead of $4.32 million: $394,000 of CloudFront requests, $1.62 million of data sent from the edges, and $34,000 of S3 reads for the misses.
- **Mutants.**
  - Photos without a CDN: the viral photo's prefix is 11.5 times busier than it can be, 19% of photo reads fail at peak, and an average day costs $4.32 million. It scores 0.
  - 256 prefixes instead of a CDN: the same, since one key lives in one prefix.
  - S4's prefix mutants now remove the CDN first, so that 16 and 60 prefixes still meet every read.

## Consequences in the corpus

- Only the news feed moved: its goldens gained a CDN, S4's average day fell from $4.32 million to $2.26 million (its budget stays at $4.35 million, which a design without a CDN meets), and S5 is new.
- **152 mutants,** every one caught.

## Known gaps

- **No eviction.** An edge keeps everything for its TTL; real edges evict objects asked for rarely, and hold fewer than a day's worth of a long tail.
- **One edge.** The edge locations and regional edge caches are one cache. A new object is fetched by many edges at first, which collapsing reduces but does not remove.
- **No TTL to choose.** The origin's `Cache-Control` could keep photos for a year; the model uses CloudFront's default day.
- **Distance.** How far clients are from the edge, or from the Region, is not modelled; the edge's advantage in latency is the origin's 120 ms it skips.
- **Uploads through the edge.** CloudFront can take uploads and forward them ($0.02 a GB to the origin); the goldens do not, and routes keep uploads around the CDN when they can.
