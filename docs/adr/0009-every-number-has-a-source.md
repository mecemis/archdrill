# ADR 0009 — Every catalog number has a source

**Status:** accepted · 2026-10-14

## Context

The catalog's capacities, latencies and prices decide every score. Until now they were documented ballparks: plausible, but with nothing a reader could check. Three problems follow from that.

- **The numbers decide the lesson.** The designs a candidate learns to prefer, and how much each one costs, all follow from these numbers. A wrong price teaches the wrong trade-off.
- **"Realistic" was a claim without evidence.** There was no way to tell a vendor's figure from a guess.
- **Errors went unnoticed.** Checking every number against a source found several that were off:
  - prices up to 35% away from list prices;
  - a third-party API that is not free at all;
  - quotas the catalog had silently assumed were raised.

[Breakscale](https://github.com/xevrion/breakscale) (MIT) faced the same question and answered it by keeping two things apart:
- **published specs**, cited with a URL and the date they were read;
- **the model** that turns specs into simulator behaviour, labelled as such.

## Decision

Every number in the catalog is either **published** or a **model**, and says which.

- **Sources.** The catalog lists its sources: title, URL, publisher, kind (price, quota, spec, benchmark or documentation) and the date read.
  - A source read second-hand names who read it (`via`).
  - The EC2, RDS and ElastiCache prices taken from Breakscale's AWS Price List data are credited this way.
- **Published.** A published number cites the source that states it, with a note where a reader needs one (Single-AZ, per stored copy, first pricing tier).
- **Model.** A model number states, in a sentence or two, how it is derived and the sources it rests on.
  - Example: pgbench reads per vCPU, discounted for network round trips and real queries.
  - A model with no source is shown as an **assumption**, so a guess never passes for a measurement.
- **Stands for.** Each size names the real offering it stands for (`db.m6i.2xlarge (RDS PostgreSQL, 8 vCPU)`).
- **Enforced by tests.**
  - Every number a size or flavor carries has a provenance.
  - Every size names what it stands for.
  - Every cited source exists, and every listed source is cited.
- **Shown in the inspector.** "Where these numbers come from" lists each number with its value, a published, model or assumption badge, the reasoning, and links with dates.

Where a number disagreed with its source, the source won:
- prices for ALB, ElastiCache, RDS, Cassandra's nodes, MSK brokers and self-managed servers;
- ElastiCache memory as AWS publishes it;
- EBS gp3 storage for Cassandra.

No score in the corpus changed.

## Known gaps

Recorded where a reader sees them (in the model text), and planned next:

- **URL-safety API.** Web Risk's Lookup API costs $0.50 per 1,000 calls beyond 100,000 a month. Real designs avoid this with a local threat list kept current by the Update API. The catalog prices neither yet.
- **Push notifications.** FCM's default quota is 600,000 messages a minute per project and counts every device. The catalog assumes a raised quota counted per multicast request.
- **Card payments.** Stripe's live-mode default is 100 requests a second per account. The payments problem assumes a contract quota of 5,000.
- **Load balancer.** ALB bills capacity units (LCU) by connections and processed bytes. The catalog charges the hourly fee only, until requests have sizes.
- **Thin assumptions.** Several capacities (service handlers, Kong, the key generation service, Flink, connection servers) are assumptions without a published measurement. They are labelled so.

## Consequences

- Changing a number means citing a source or writing down the model, which slows careless edits on purpose.
- Prices date. A source's read date shows how old a figure is, and refreshing them is a content task, not a code change.
- Calibration comes next: reference points that the engine must reproduce within a tolerance, for example pgbench reads per vCPU or etcd's write throughput. These turn the model texts into tests.
