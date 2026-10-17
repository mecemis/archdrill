# ADR 0018 — Both regions taking traffic

**Status:** accepted · 2026-10-17 · builds on [ADR 0016](0016-a-standby-region.md) and [ADR 0017](0017-reading-your-own-writes.md)

## Context

[ADR 0016](0016-a-standby-region.md) gave a design a standby region that waits. The other answer to a lost region is to run both regions all the time (active-active), each serving the users nearest to it. AWS's [disaster recovery options](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html) list three ways to handle writes in that case:
- *write global*: every write goes to one region;
- *write local*: each region writes where it is;
- *write partitioned*: each key has a home region.

What write local does to uniqueness is the interview question:
- **MREC.** A DynamoDB global table in its default mode, [multi-Region eventual consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html), replicates writes "typically within a second or less", and resolves concurrent writes by "last writer wins". Its "conditional writes evaluate the condition expression against the version of the item in the Region". A create that checks a code with a conditional insert therefore checks only its own region's copy. Two people who claim the same alias in different regions within a second both get 201, and one link silently replaces the other.
- **MRSC.** Multi-Region strong consistency evaluates conditions against the latest version. It needs exactly three regions, has higher write latency, and supports neither TTL nor transactions.
- **The distance.** Writing in one place costs the other region a round trip. AWS publishes no figure for it; third-party measurements put us-east-1 to us-west-2 at about 68 ms.

## Decision

- **A region-mode decision.** A scenario's workload can name it (`regionMode: { decision }`), with options `active-passive` and `active-active`. URL shortener S9 offers it.
- **While both regions take traffic:**
  - A component with a standby copy runs both copies. A placed fleet has twice the instances and twice the autoscaling range. A store serves reads from both copies but keeps one primary per shard, so its writes do not double.
  - The second copy is billed as the component's own, not as a standby.
  - Each region fills its own cache from its own traffic, so nothing replicates caches.
- **Calls that cross** (68 ms each). Half the requests come from the other region. They cross on:
  - every call to a component that runs in the primary region only;
  - writes and consistent reads to a store whose writes go to a primary;
  - a write sent to the home region (`homeRegion: true` on a store write).

  Latency is computed for each region's requests apart. A request from the other region crosses on every such call, and the tail stays right: it is not a coin toss per call.
- **Losing a region while both took traffic:**
  - Only the lost region's clients fail until DNS moves them: half the requests at the way in.
  - A store with one primary takes no writes from either region until its copy is promoted.
  - Autoscaled fleets keep the half that ran in the other region, and the autoscaler keeps working.
  - The surviving region's cache is warm.
  - In an environment, a lost region leaves one region's copies, as before.
- **The check** (`unique-across-regions(operation, entity, decision)`). It applies only to active-active designs, and its decision must be the one the workload names.
  - It fails a conditional create that writes in each region to a store taking writes in both, where codes can really clash:
    - aliases people choose;
    - codes from a key service that runs in both regions and hands out the same ranges.
  - Random codes checked in each region pass: two regions drawing the same 8-character code within a second is negligible.
  - A store with one primary, or a create sent to the home region, checks in one place and passes.
- **Shown.**
  - "Write in the home region" on store writes in the flow editor.
  - The region-mode decision in Decisions.

## Consequences in the corpus

- **S9 gains `codes-unique-across-regions`** (gate, critical). Active-passive designs are not judged by it.
- **A new golden, `dynamodb-redis-active-active`**, runs the DynamoDB design in both regions and sends creates to the home region. Against the warm standby, `dynamodb-redis-two-regions`, in S9:

  | | Warm standby | Active-active |
  |---|---|---|
  | Average day | $60,499 | $59,829 |
  | Create p50 / p99 | 8.5 / 14.8 ms | 15.6 / 108 ms (half the creates cross) |
  | Worst success while the region goes | 0% | 50% |
  | Redirects back for good | 210 s | 215 s |

  Active-active costs no more here: its fleets run what the load needs in both regions instead of a minimum in one. It halves the outage but does not shorten it. When DNS moves the lost region's clients, the surviving half of each fleet takes the whole peak and has to scale up, which is the hot-standby lesson again.
- **One mutant**, 141 in all, every one caught: creates that write in each region.

## Known gaps

- **Only scenarios that name the decision run active-active.** In S3 and S5, the golden is costed as a warm standby.
- **Users split evenly between regions, and their distance is not modelled.** Active-active's lower latency for far users does not show.
- **Each region's cache is taken to hit as one cache seeing all traffic would.**
- **The home region moves at once.** After a loss, writes sent "home" go to the surviving region without delay.
- **Cross-region calls are not billed.** Only replication to the other region is.
- **MRSC is not in the catalog.** Its three regions, its write latency and its missing TTL are left out. Synchronous replication across regions is not modelled either: a write's acknowledgement only waits within the region.
- **A lost zone in an active-active environment** takes its share of both regions' instances.
- **The Regions control still says "standby"** for a copy that takes traffic.
