# ADR 0012 — Load balancers billed by connections and bytes

**Status:** accepted · 2026-10-16 · builds on [ADR 0009](0009-every-number-has-a-source.md) and [ADR 0011](0011-work-units-and-bandwidth.md)

## Context

The managed load balancer cost its hourly charge, $16 a month, whatever went through it. ALB also bills capacity units (LCUs) each hour, for whichever of four dimensions needs the most:

- 25 new connections a second;
- 3,000 active connections, those open at once;
- 1 GB of requests and responses an hour;
- 1,000 rule evaluations a second beyond the first 10 rules.

A unit costs $0.008 an hour. What it comes to depends on what the engine did not know: how big requests and responses are, and how many requests a client sends over one connection. A visitor who clicks a short link opens a connection for one redirect; an API client sends tens of thousands over one pooled connection.

## Decision

- **Sizes on operations.** Every operation clients request gives `bytes: { request, response }`, its size on the wire with HTTP headers, compressed where a response would be. Validation requires them.
- **How clients connect** (`client` in a problem).
  - `requestsPerConnection` and `connectionSec`: a connection carries that many requests and stays open that long, the idle time before it is closed included. The default, one request and 60 seconds (ALB's idle timeout), is the costliest.
  - Where a scenario's environment says how many clients hold WebSockets (`connections`), those are the open connections, each lasting `connectionSec`, whatever is sent over them. They are spread over the components clients connect to by their share of requests.
  - Each problem says why in a comment:
    - URL shortener: every click is a new visitor;
    - rate limiter: pooled connections that ALB closes after an hour, its default keep-alive duration;
    - news feed: a reading session of about ten pages;
    - chat: 20 million WebSockets renewed every 55 minutes.
- **Capacity units** (`capacityUnits` on a flavor): `pricePerHour` and what one unit covers on each dimension, published from AWS's price page. The engine bills the largest dimension. Rule evaluations are left out, since these designs route with fewer than the 10 free rules.
- **Where it is computed.**
  - Requests that clients send straight to a component are counted where they enter, so only the first hop sees client connections; proxies behind it keep theirs open.
  - Every proxy on the way forwards the request and the response: those are its processed bytes, and they fill its network where the catalog gives one.
  - NGINX and Kong stand for c6i.xlarge, with its published baseline of 1.562 Gbps.
- **Shown.**
  - The inspector lists a flavor's capacity units with their source.
  - The load panel shows a load balancer's units and what sets them, and the cost summary shows their total.
  - The budget check names them in its details: "ALB: $23,376/month, $23,360 of it for 4,000 capacity units set by 100,000 new connections a second".

## Consequences in the corpus

- **A redirect service pays per click.** ALB in front of 100,000 redirects a second takes 4,000 units, about $23,000 a month on an average day and $70,000 at peak. That fails the URL shortener's S3 budget ($40,000), which is a gate, and S8's ($60,000 at peak).
- **The goldens moved to NGINX.** The three goldens that pass S3 and S5 now front their services with NGINX fleets of 4 vCPUs: 25 instances for the two that absorb the viral spike, 8 for the fixed fleet. Their scores are unchanged.
- **The lesson is kept.** A new mutant, `alb-for-redirects`, puts ALB back and fails S3's budget. All 125 mutants are caught.
- **Designs that reuse connections pay for bytes.** The rate limiter's ALB comes to $12,600 a month on an average day (400,000 requests of 1.5 KB) and the news feed's to $21,300 (pages of about 6 KB). Both stay within budget.
- **Designs already over budget fall further.** The S5 scores of the URL-shortener goldens expected not to pass it drop: `dynamodb-direct` and `postgres-sized-for-cache-loss` to 10, and `postgres-redis-fixed-fleet` to 18, since its NGINX fleet is sized for the known peak like the rest of it.

## Known gaps

- **One connection pattern per problem.** Every operation shares its client's pattern, so a problem whose clients mix one-off requests and long sessions takes an average.
- **One size per operation.** A 404, a 410 or a 429 is billed like a full response.
- **No other way in.** Network load balancers (800 new connections a unit, without TLS termination) and CDNs would change a redirect service's bill, and neither is in the catalog.
- **Services have no bandwidth.** Only proxies count what they forward; a service's responses and calls are not limited yet.
- **TLS and the internet.** Handshakes are not processed bytes, so they are left out. Data transfer out to the internet is the same for every design that serves the same responses, and it is not counted.
- **Reserved units.** ALB can reserve units ahead of a known spike, and that is not modelled.
