# Problem design: Chat and Notifications

The fourth problem pack. Its lessons are that holding millions of connections open is a capacity problem of its own, and that delivery, ordering and presence each break a different naive design.

## Brief

A messaging app with one-to-one and group conversations (up to 500 members). Connected users get messages over a WebSocket; others get a push notification. Everyone in a conversation sees the same order; a message is delivered at least once and shown once. Users see which contacts are online.

| Quantity | Value |
|---|---|
| Connected users | 20 million at peak, each holding a WebSocket |
| Messages | 200,000 /s at peak; most one-to-one, one in ten to a group |
| Recipients | 1 for most messages, 10 in a typical group, up to 500 |
| Presence | a heartbeat every 30 s per connected user; 20 contacts on screen |

## Requirements

| ID | Requirement |
|---|---|
| FR-1 | Send to one-to-one and group conversations |
| FR-2 | Connected recipients get the message at once; others a push notification |
| FR-3 | One order per conversation for everyone |
| FR-4 | Contacts' online status |
| NFR-1 | Delivery p99 < 1 s; sending p99 < 300 ms |
| NFR-2 | At least once, shown once, also when clients resend |
| NFR-3 | Every connection held at peak, with room to spare |

## Model

- **Connections.** An environment says how many clients hold a connection, and connection servers hold them (250,000 per instance).
  - A gateway's utilisation is the larger of its request load and its share of connections.
  - Autoscaling therefore sizes the fleet for connections.
- **Entities.**
  - `Message` is durable and keyed by the client's message id.
  - `ConversationSeq` is a counter in memory, rebuilt from the latest message after a loss.
  - `Session` (which server holds a user's connection) and `Presence` live in memory.
- **Counts.** `onlineRecipients`, `offlineRecipients` and `contactsShown` size the fan-outs.
- **Calls.** `connection.push` sends a frame down an open connection. `external.notify` asks a push provider (100,000 requests a second) to notify devices, many per request when batched.
- **Decision.** `message-order`: the sender's clock, the server's clock, or a sequence per conversation.

## Scenarios

### S1: Send and deliver
Peak with 20 million connections.
- **Gate:** messages reach a consumer that delivers them.
- **Checks:**
  - connected recipients get a push over their connection;
  - the others get a notification;
  - a resent message is stored once (a conditional insert on the client's id);
  - messages get a sequence number per conversation, and order does not come from clocks;
  - delivery p99 under 1 s, sending p99 under 300 ms;
  - nothing above 85%, connections included;
  - peak under $100,000 a month.

### S2: Large groups
One message in fifty goes to a group of 500.
- **Checks:**
  - delivery keeps up;
  - nothing above 85%, so notifications must be batched to stay within the provider's quota;
  - delivery p99 under 2 s.

### S3: Presence
670,000 heartbeats a second, and contact lists showing 20 statuses.
- **Checks:**
  - heartbeat p99 under 100 ms, status p99 under 200 ms;
  - nothing above 85%;
  - presence kept out of durable stores.
- **Signal:** heartbeats are not broadcast.

## Corpus

| ID | Design | Scenarios |
|---|---|---|
| `gateways-and-sequences` | Connection servers (80 to 200, scaled for connections) → chat service. It takes a sequence number from Redis, stores the message in Cassandra with a conditional insert, and publishes to Kafka. The delivery service looks up sessions, pushes in batches through the connection servers, and sends notifications in batches of 100. Presence lives in Redis with a TTL and is read in one batched lookup. | S1, S2, S3 |
| `fixed-gateways` | 115 fixed connection servers and one notification request per device. | S1, S3 |

Ten mutants cover:
- delivery: messages not published, and messages not delivered;
- resends: a plain insert that stores a resent message twice;
- ordering: no sequence numbers, and order by the client's clock;
- reaching recipients: nothing pushed over open connections, and no notifications;
- capacity: too few connection servers, unbatched notifications, and unbatched presence reads.

## Estimates

The pack asks:
- connection servers for 20 million users (115);
- heartbeats a second (670,000);
- deliveries for large groups (2 million/s);
- what broadcasting presence would cost (133 million pushes/s);
- messages a day (5.8 billion).
