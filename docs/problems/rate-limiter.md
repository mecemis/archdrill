# Problem design: Distributed Rate Limiter

The second problem pack. Its lesson is that a limiter sits on every request: where it counts decides whether the limit holds, what every request pays for it, and what happens when the counter itself fails or is overwhelmed by the clients it exists to stop.

## Brief

A public API platform serves its customers through a fleet of API servers. Every key has a limit (most keys 100 requests a second). Requests over the limit get 429 with a Retry-After; the others go to the backend. Limits hold across the whole fleet, the limiter costs a request almost nothing, and a broken limiter never takes the API down.

| Quantity | Value |
|---|---|
| API requests | 400,000 /s on average, 1,000,000 /s at peak; about 2% from keys over their limit |
| API keys | 50,000 active, Zipf-skewed (s ≈ 1.1) |
| Limits | 100 requests /s per key for most keys |

## Requirements

| ID | Requirement |
|---|---|
| FR-1 | Over the limit: 429 with Retry-After |
| FR-2 | Limits hold across the fleet, not per server |
| NFR-1 | API p99 < 50 ms; the limiter adds a few milliseconds at most |
| NFR-2 | 99.99% availability, also while the counter store fails |
| NFR-3 | A client far over its limit cannot overload the backend for everyone |
| NFR-4 | Window boundaries never let a client through at more than 1.5× its limit |

## Model

- **Entities.** `ApiKey`, `RateCounter` (ephemeral, keyed by key) and `Block` (ephemeral, and it exists only for clients over their limit: `existsFor: overLimit`).
- **Facts.** `overLimit` (the key is over its limit) and `farOverLimit` (thousands of times over).
- **Logic.**
  - `checkLimit` compares a count with the limit, decided by `overLimit`.
  - `checkLocalLimit` compares one server's own count with the limit divided by the fleet, decided by `farOverLimit`: it only catches clients far over their limit.
- **Calls.** `counter.increment` on Redis (atomic, short-lived counters may live in memory) or on an in-process cache, `cache.get`/`cache.set` of a block marker, and `service.call` to hand an allowed request to the backend.
- **Decision.** `window-algorithm`: fixed window, sliding log, sliding counter or token bucket.

## Scenarios

### S1: Enforce limits
Average day (400,000/s) and peak (1,000,000/s).
- **Gates:**
  - every allowed request passed a limit check;
  - requests over the limit get 429.
- **Checks:**
  - limits hold across the fleet (`limits-are-global`: the deciding count is shared, or a server's own only after the shared count failed);
  - no fixed windows;
  - p99 under 50 ms at peak, nothing above 85%;
  - an average day under $40,000 a month.
- **Signal:** increments are not retried.

### S2: When the limiter fails
The counter store down, hanging, and down while a scraper adds 500,000 requests a second.
- **Gate:** 99.99% while the store is down (fail open).
- **Checks:**
  - p99 under 50 ms while it hangs, with counter calls timing out within 10 ms;
  - the backend survives the scraper (a fallback that counts on each server);
  - local counts only as a fallback.
- **Signal:** a circuit breaker on the counter store.

### S3: A client goes rogue
One key sends 300,000 requests a second.
- **Checks:**
  - nothing above 85% (all its increments land on the shard that holds its key);
  - everyone else at 99.99% and under 50 ms p99.
- **Fix:** an in-process block marker with a one-second TTL rejects the key without counting.

## Corpus

| ID | Design | Scenarios |
|---|---|---|
| `redis-sliding-counter` | Block marker in an in-process cache → atomic increment in Redis (12 shards × 2, 5 ms timeout, breaker) → `checkLimit` → backend or a one-second block and 429; on a Redis error, a server's own count and `checkLocalLimit`. Sliding window counter. | S1, S2, S3 |
| `redis-token-bucket` | The same without a block marker, with a token bucket. A runaway client saturates its shard. | S1, S2 |

Eleven mutants cover:
- the gates: no limit check, and over-limit requests forwarded;
- fleet-wide limits: counting skipped, and server-local counts;
- fixed windows, undersized counters, and retried increments;
- the outage: failing closed, no counter timeout, and failing open without a fallback;
- a missing block marker.

## Estimates

The pack asks:
- counter updates at peak (1,000,000/s);
- Redis shards at 70% (12);
- sliding-log memory (6 GB);
- the boundary burst of fixed windows (200 in one second for a limit of 100);
- what server-local limits let through on 400 servers (40,000/s).
