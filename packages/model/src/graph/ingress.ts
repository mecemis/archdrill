import type { Architecture, Attempt } from "../attempt/schema";
import { INGRESS_CAPABILITIES } from "../catalog/capabilities";
import type { CatalogIndex } from "../catalog/schema";
import type { Operation } from "../problem/schema";

export interface IngressRoute {
  /** Component ids from a client to the handler, inclusive. */
  readonly components: readonly string[];
  /** Connection ids between consecutive components. */
  readonly connections: readonly string[];
}

/**
 * Shortest synchronous route from any client to the handler. Intermediate hops
 * must be able to carry traffic (load balancers, gateways, CDNs). Ties break
 * deterministically by component id.
 */
export function findIngressRoute(
  architecture: Architecture,
  catalog: CatalogIndex,
  handlerId: string,
): IngressRoute | null {
  const byId = new Map(architecture.components.map((c) => [c.id, c]));
  const canForward = (id: string) => {
    const c = byId.get(id);
    if (!c) return false;
    const caps = catalog.capabilities(c.kind, c.flavor);
    return [...INGRESS_CAPABILITIES].some((cap) => caps.has(cap));
  };

  const outgoing = new Map<string, { to: string; connection: string }[]>();
  const sorted = [...architecture.connections].sort((a, b) => a.to.localeCompare(b.to));
  for (const conn of sorted) {
    if (conn.mode !== "sync") continue;
    const list = outgoing.get(conn.from) ?? [];
    list.push({ to: conn.to, connection: conn.id });
    outgoing.set(conn.from, list);
  }

  const clients = architecture.components
    .filter((c) => catalog.capabilities(c.kind, c.flavor).has("traffic-source"))
    .map((c) => c.id)
    .sort();

  const previous = new Map<string, { from: string; connection: string } | null>();
  const queue: string[] = [];
  for (const client of clients) {
    previous.set(client, null);
    queue.push(client);
  }

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] as string;
    if (current === handlerId) return buildRoute(previous, handlerId);
    const isStart = previous.get(current) === null;
    if (!isStart && !canForward(current)) continue;
    for (const edge of outgoing.get(current) ?? []) {
      if (previous.has(edge.to)) continue;
      previous.set(edge.to, { from: current, connection: edge.connection });
      queue.push(edge.to);
    }
  }
  return null;
}

function buildRoute(
  previous: Map<string, { from: string; connection: string } | null>,
  target: string,
): IngressRoute {
  const components: string[] = [target];
  const connections: string[] = [];
  let link = previous.get(target);
  while (link) {
    components.unshift(link.from);
    connections.unshift(link.connection);
    link = previous.get(link.from);
  }
  return { components, connections };
}

/**
 * Queues that carry messages about an event: the targets of the publish
 * steps for it, in any flow.
 */
export function queuesFor(event: string, attempt: Attempt): Set<string> {
  const queues = new Set<string>();
  for (const flow of attempt.flows) {
    for (const step of Object.values(flow.steps)) {
      if (step.type === "call" && step.action === "queue.publish" && step.event === event) {
        queues.add(step.target);
      }
    }
  }
  return queues;
}

/**
 * How work reaches an operation's handler. Requests come from a client over
 * the ingress route; messages come from a queue that the handler consumes
 * (it connects to a queue some flow publishes the event to); scheduled jobs
 * start in the handler itself.
 */
export function findOperationRoute(
  operation: Operation,
  attempt: Attempt,
  catalog: CatalogIndex,
  handlerId: string,
): IngressRoute | null {
  const trigger = operation.trigger;
  if (trigger.type === "request") return findIngressRoute(attempt.architecture, catalog, handlerId);
  if (trigger.type === "schedule") return { components: [handlerId], connections: [] };
  const queues = queuesFor(trigger.event, attempt);
  const connection = [...attempt.architecture.connections]
    .sort((a, b) => a.id.localeCompare(b.id))
    .find((c) => c.from === handlerId && queues.has(c.to) && c.mode === "sync");
  return connection
    ? { components: [connection.to, handlerId], connections: [connection.id] }
    : null;
}
