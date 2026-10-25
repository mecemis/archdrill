# ADR 0021 — Object storage that answers clients itself

**Status:** accepted · 2026-10-25 · builds on [ADR 0003](0003-shared-architecture-flow-overlays.md), [ADR 0009](0009-every-number-has-a-source.md) and [ADR 0011](0011-work-units-and-bandwidth.md)

## Context

Every operation had a service as its handler: a request reached a service, and the service called stores. Media does not work that way, and the lesson an interviewer looks for is exactly that:
- **Photos skip the services.** Clients put photos into object storage and fetch them from it themselves. The service only signs an upload URL for one key, and later hands out the photo's address.
- **Relaying bytes is expensive.** 300,000 photos of 200 KB a second is 60 GB a second, about 480 Gbps.
  - A c6i.xlarge sustains 1.562 Gbps ([network specifications](https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html)), so relaying them takes some 300 instances.
  - An Application Load Balancer bills an LCU for each GB processed an hour: carrying 30 GB a second costs over $600,000 a month.
- **Object storage has a rate per prefix.** S3 takes at least 3,500 PUT, COPY, POST or DELETE and 5,500 GET or HEAD requests a second per partitioned prefix, with no limit on prefixes ([performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)). It answers small objects in "roughly 100–200 milliseconds".
- **It bills per request.** The Price List API (published 2026-10-15) gives S3 Standard $0.0004 per 1,000 GETs, $0.005 per 1,000 PUTs, and $0.023 a GB-month for the first 50 TB. Moving data between S3 and other services in its Region is free ([pricing](https://aws.amazon.com/s3/pricing/)).
- **Services had no network.** [ADR 0011](0011-work-units-and-bandwidth.md) left their bandwidth out: only proxies counted what they forwarded. A service relaying photos could not run out of anything.

## Decision

- **A capability, `serves-objects`.** A component with it takes whole objects from clients and hands them back itself.
  - It can handle an operation that clients request (`canHandle` now takes the trigger): services handle any, stream processors only messages from a queue, object storage only clients' requests.
  - A flow it handles can only respond: it answers with the object, or stores it. A call or a decision there is an error, `flow-handler-serves-only`.
  - It calls nothing, so the step picker, the suggestions, the patterns and the command line offer it only a response, first in the flow.
- **A kind, `object-store`, and a flavor, S3 Standard.**
  - Shards are its prefixes (`shardsLabel`): each takes 5,500 reads and 3,500 writes a second, and costs nothing. The inspector lets a design spread its keys over up to 256.
  - Managed and redundant across zones, with no instances, no zones to place and no cross-zone charges.
  - $0.40 a million reads, $5 a million writes, and $0.023 a GB a month for the data bound to it.
  - A mean of 120 ms a request with a coefficient of variation of 0.35: four requests in five between about 70 and 180 ms.
  - It is also a durable store, so a service can read and write objects in it as it does in any store.
- **Signing uploads.** A decision, `signUpload`, signs a URL for one key. It needs a connection to object storage (whose bucket it signs for), and makes no call.
- **What a handler sends.** A handler's network carries what it sends: the response to each request it serves, and the items its calls send (writes, messages, requests to other services), but not those to a component in its own memory. Proxies still count the request and the response they forward.
- **Services get a network.** Each size has the baseline of the c6i instance it stands for: 0.781, 1.562 and 3.125 Gbps. Like any resource, it joins CPU in a service's utilisation, so an autoscaler adds instances for it too.
- **Two checks.**
  - `direct-writes-signed`: when clients write straight to object storage, every success path of the operation that hands out upload URLs signs one. It does not apply when uploads go through a service.
  - `entity-durable`: a durable store keeps the entity, not only a cache. A design that serves photos from storage it never bound them to would otherwise pay nothing to keep them.

## The photos scenario (news feed S4)

- **The problem.** Posts can carry a 200 KB photo: one post in twenty, so 500 uploads a second at peak, and a timeline page shows about one, 300,000 photo reads a second. A year of photos, 8 billion of them, is kept.
  - Three operations: `start-upload` (the service answers with a key and an upload URL), `upload-photo` and `read-photo`.
  - `start-upload` is optional: a design that relays uploads needs no URLs.
  - The scenario runs the feed's own traffic too, so photos share the load balancer and the services with timelines.
- **Checks.** Only signed URLs upload (a gate), photos are kept durably (a gate), 99% of photos load at peak (a gate), their p99 stays under 300 ms, nothing runs above 85% at peak, and an average day costs less than $275,000 a month. Two senior signals: photos, and uploads, go straight between clients and object storage.
- **The goldens.** Both news feed goldens keep photos in S3 over 70 prefixes (78% busy at peak). The post service signs uploads, and S3 answers uploads and reads itself.
  - They score 100. An average day costs about $251,000: $161,000 in S3 requests, $37,000 to keep 1.6 PB, and the feed's own $53,000.
  - Photos take 116 ms at the median and 239 ms at p99.
- **Mutants.**
  - The timeline service relays every photo: it would need 3.97 times the network of its 40 instances at peak, 75% of photos fail, and the load balancer's capacity units cost $655,000 a month. It scores 35.
  - The post service takes every upload: only the senior signal catches it, since 500 uploads a second are 0.8 Gbps.
  - Unsigned upload URLs, photos bound to nothing, 16 prefixes (71% of photos fail at peak) and 60 prefixes (91% busy at peak) are each caught.

## Consequences in the corpus

- **No other score moved.** Services now have a network, and the busiest uses 17% of it: the news feed's timeline service at peak, sending 6 KB pages.
- **150 mutants,** every one caught.

## Known gaps

- **Data sent to the internet was not billed.** Every design returns the same bytes to its clients, so leaving out S3's and the load balancer's $0.09 a GB changed no comparison. Part 2 bills it for every design ([ADR 0022](0022-data-sent-to-the-internet.md)), ahead of a CDN that makes it a choice.
- **Inbound traffic is still not counted** ([ADR 0011](0011-work-units-and-bandwidth.md)). A service that relays uploads receives them, and then sends them to storage; only the second counts, which is the same bytes.
- **One size of photo.** Thumbnails, and the work of making them, are left to the debrief.
- **Prefixes scale at once.** S3 partitions a busy prefix gradually and answers 503 Slow Down meanwhile; a design's prefixes are taken as partitioned already.
- **Reads need no signature.** Photos are taken to be public, as posts are; signed reads are not modelled.
