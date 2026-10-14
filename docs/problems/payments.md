# Problem design: Orders and Payments

The fifth problem pack. Its lessons are about money and exactly-once effects: idempotency keys, compensation when a step fails, writing an event with the data it reports, and settling what a timeout left unknown.

## Brief

An online store's checkout reserves the items, charges the card through a payment provider, confirms the order and hands it to fulfilment. Clients resend orders whose answer got lost; the provider sometimes times out without saying whether it charged. Nobody is charged twice or for an unconfirmed order, and every confirmed order ships exactly once.

| Quantity | Value |
|---|---|
| Orders | 500 /s on average, 2,000 /s at peak; 1 card in 20 declined |
| Payment provider | 5,000 requests /s, raised by contract (Stripe's live-mode default is 25 per endpoint); a charge takes about 300 ms |
| Resent orders | about 1 in 100 |

## Requirements

| ID | Requirement |
|---|---|
| FR-1 | Place an order: reserve, charge, confirm |
| FR-2 | A decline releases the items and answers 402 |
| FR-3 | Every confirmed order ships exactly once |
| NFR-1 | Never charged twice, never charged for an unconfirmed order |
| NFR-2 | Checkout p99 < 3 s; 99.9% available, also while the event queue is down |
| NFR-3 | An unknown charge is settled against the provider's records |

## Model

- **Entities.** `Order` (keyed by the client's order id), `Reservation` and `Shipment`.
- **Facts.**
  - `cardDeclined` decides the charge.
  - `duplicate` makes a conditional insert find the first copy of a resent order.
- **Calls.**
  - `external.charge` (approved, declined or error) and `external.refund` take an idempotency key, which makes retrying them safe.
  - `payments.lookup` reads the provider's record.
  - A publish can go through a **transactional outbox**. It is written with the store write before it and relayed afterwards. Validation checks that, on every way in, the last store write before it is transactional and reached through its ok outcome. It has no error outcome, adds no latency, and is never lost.
- **Check.** `no-dual-write(operation, event)` fails a publish made after the write commits (a failed publish loses the event) or before it (the event can report a write that fails).

## Scenarios

### S1: Checkout
Average day and peak, with declines and resent orders.
- **Gates:**
  - a resent order is recognised (a conditional insert on the order id);
  - charges are never retried without an idempotency key.
- **Checks:**
  - a resent order is not charged again;
  - a decline releases the reservation and answers 402;
  - a confirmation that fails after the charge refunds it;
  - checkout p99 under 3 s, nothing above 85%, and an average day under $15,000.

### S2: Fulfilment
Peak, and the event queue down.
- **Gate:** confirmed orders reach fulfilment.
- **Checks:**
  - an order and its event commit together;
  - a redelivered order ships once;
  - checkout keeps 99.9% while the queue is down;
  - fulfilment keeps up.

### S3: When the provider misbehaves
The provider slow, then hanging.
- **Gate:** an unknown charge leaves the order pending (202).
- **Checks:**
  - checkout p99 under 3 s and 99% available while the provider hangs, with charges timing out within 2 s;
  - pending orders are settled by a job that looks them up with the provider.
- **Signal:** a circuit breaker on the provider.

## Corpus

| ID | Design | Scenarios |
|---|---|---|
| `outbox-saga` | Order service on PostgreSQL. Conditional order insert, reservation, and a charge with an idempotency key (retried once, 1.5 s timeout, breaker). A decline releases and answers 402; a timeout leaves the order pending (202); a failed confirmation refunds. The outbox carries `order-confirmed`. A fulfilment worker records shipments with a conditional insert, and a reconciliation job looks pending orders up. | S1, S2, S3 |
| `publish-after-commit` | The same, publishing in its own call after the commit. | S1, S3 |

Ten mutants cover:
- checkout: a plain order insert, retries without a key, a resent order charged again, stock kept after a decline, a decline answered 503, and no refund;
- fulfilment: nothing fulfils the events, and a shipment booked per delivery;
- the provider: an unknown charge confirmed, and charges that wait 10 s.

## Estimates

The pack asks:
- orders a day (43 million);
- requests to the provider at peak (2,100/s);
- double charges a day without idempotency keys at a 0.5% ambiguous-timeout rate (216,000);
- orders lost a day to a 1-in-10,000 publish failure after commit (4,300).
