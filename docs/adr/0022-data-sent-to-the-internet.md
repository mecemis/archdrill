# ADR 0022 — Data sent to the internet

**Status:** accepted · 2026-10-25 · builds on [ADR 0009](0009-every-number-has-a-source.md), [ADR 0015](0015-traffic-between-zones.md) and [ADR 0021](0021-object-storage.md)

## Context

Every answer a design sends its clients leaves the Region over the internet, and AWS bills it. The catalog priced instances, requests, storage and traffic between zones, but not this:
- **The rates.** The Price List API for AWS Data Transfer (published 2026-09-16) bills data out of US East (N. Virginia) to the internet in tiers of the month's total: $0.09 a GB for the first 10 TB, $0.085 for the next 40 TB, $0.07 for the next 100 TB and $0.05 beyond 150 TB. The same rates apply from EC2, load balancers and S3. Data in from the internet is free, as are the first 100 GB a month.
- **It is often the largest line.** The news feed sends 150,000 timeline pages of 6 KB a second on an average day: 2.4 PB a month, about $122,000. Photos ([ADR 0021](0021-object-storage.md)) send 30 GB a second, about $4 million.
- **Until now it made no difference.** Every design returns the same bytes to its clients, so leaving it out changed no comparison. A CDN (M25, part 3) changes that: CloudFront sends the same bytes for $0.085 down to $0.02 a GB, and data from S3 to CloudFront is free. Without this bill, a CDN could only look more expensive, since its requests cost more than S3's.

## Decision

- **The catalog** has `internetTransfer`: the tiers above, cited, priced on the month's GB (10⁹ bytes, as the catalog's other transfer prices).
- **What is sent.** The component a client talks to (the first hop of the ingress route: a load balancer, a gateway, a service, object storage) sends the answer to each request clients send it: the operation's `bytes.response`. Propagation records it as `toClients`.
- **The bill.** Each environment adds what every component in the Region sends clients, prices the month's total in the tiers, and gives each component its share in proportion to what it sent: `costBreakdown.internet`. Components outside the Region (clients, third-party APIs) send nothing to bill.
- **Shown.** The Load table gives each component's share and the total ("to the internet"), and the budget finding says how much of a component's cost is for sending to clients, and at what rate.

## Consequences in the corpus

What a scenario sends is the same for every design that answers the same requests, so the bill is a constant per scenario. Every budget that it pushed out moves up by it, rounded, so that what the budget catches stays the same:

| Scenario | Budget environment | Sent to the internet | Budget |
|---|---|---|---|
| URL shortener S3 | average day | $6,338 | $46,000 → $52,500 |
| URL shortener S5 | average day | $6,412 | $48,000 → $54,500 |
| URL shortener S8 | peak | $15,717 | $60,000 → $76,000 |
| URL shortener S9 | average day | $6,412 | $86,000 → $92,500 |
| Rate limiter S1 | average day | $56,451 | $40,000 → $96,500 |
| News feed S1 | average day | $122,348 | $60,000 → $182,500 |
| News feed S4 | average day | $4,074,262 | $275,000 → $4,350,000 |

- **Unchanged.** Chat S1 sends $4,830 at peak and payments S1 $59 an average day; both stay well within their budgets, which do not move.
- **Scores.** Every golden that passed a budget still passes it. Two partial scores rise slightly, since a budget moved by a constant makes the same overshoot a smaller share: `postgres-redis-two-regions` in URL shortener S8 (85 → 89) and `postgres-sized-for-cache-loss` in S5 (18 → 24). No band changed.
- **Mutants.** 150, every one caught.

## Known gaps

- **One price for the Region.** Every component shares the Region's tiers, and the first 100 GB a month, free across services, are billed. Private pricing and savings plans are left out, as for every price.
- **Only answers to requests.** Frames pushed over held connections (chat's deliveries) carry no size in the model yet, and calls to third-party APIs over the internet send a few hundred bytes each; neither is billed.
- **A GB of 10⁹ bytes,** the unit the catalog uses for traffic between zones. A bill that counts 2³⁰ bytes to the GB is about 7% lower.
