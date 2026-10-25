import type { Architecture, Attempt } from "../attempt/schema";
import { liveStepIds } from "../attempt/steps";
import { INGRESS_CAPABILITIES } from "../catalog/capabilities";
import type { CatalogIndex } from "../catalog/schema";
import type { Operation } from "../problem/schema";

export interface IngressRoute {
  /** Component ids from a client to the handler, inclusive. */
  readonly components: readonly string[];
  /** Connection ids between consecutive components. */
  readonly connections: readonly string[];
}

/** Which way a request goes when a CDN offers a route: through it, around it, or the shortest. */
export type EdgePreference = "through-edge" | "around-edge" | "shortest";

/**
 * Shortest route from any client to the handler. Intermediate hops
 * must be able to carry traffic (load balancers, gateways, CDNs). Ties break
 * deterministically by component id. Requests a CDN can answer prefer a
 * route through one, and other requests a route around any, when the design
 * offers both.
 */
export function findIngressRoute(
  architecture: Architecture,
  catalog: CatalogIndex,
  handlerId: string,
  preference: EdgePreference = "shortest",
): IngressRoute | null {
  const byId = new Map(architecture.components.map((c) => [c.id, c]));
  const capabilitiesOf = (id: string) => {
    const c = byId.get(id);
    return c ? catalog.capabilities(c.kind, c.flavor) : new Set<string>();
  };
  const forwards = (id: string) =>
    [...INGRESS_CAPABILITIES].some((cap) => capabilitiesOf(id).has(cap));
  const isEdge = (id: string) => capabilitiesOf(id).has("edge-cache");
  const outgoing = new Map<string, { to: string; connection: string }[]>();
  const sorted = [...architecture.connections].sort((a, b) => a.to.localeCompare(b.to));
  for (const conn of sorted) {
    const list = outgoing.get(conn.from) ?? [];
    list.push({ to: conn.to, connection: conn.id });
    outgoing.set(conn.from, list);
  }
  const clients = architecture.components
    .filter((c) => catalog.capabilities(c.kind, c.flavor).has("traffic-source"))
    .map((c) => c.id)
    .sort();
  const search = (starts: readonly string[], target: string, canForward: (id: string) => boolean) =>
    shortestRoute(outgoing, starts, target, canForward);

  const shortest = () => search(clients, handlerId, forwards);
  if (preference === "around-edge") {
    return search(clients, handlerId, (id) => forwards(id) && !isEdge(id)) ?? shortest();
  }
  if (preference === "through-edge") {
    const routes = architecture.components
      .map((c) => c.id)
      .filter((id) => id !== handlerId && isEdge(id))
      .sort()
      .flatMap((edge) => {
        const toEdge = search(clients, edge, (id) => forwards(id) && !isEdge(id));
        const onward = toEdge && search([edge], handlerId, forwards);
        return toEdge && onward ? [joinRoutes(toEdge, onward)] : [];
      })
      .sort((a, b) => a.components.length - b.components.length);
    return routes[0] ?? shortest();
  }
  return shortest();
}

/** Breadth-first: the fewest hops from any start to the target, through components that forward. */
function shortestRoute(
  outgoing: ReadonlyMap<string, readonly { to: string; connection: string }[]>,
  starts: readonly string[],
  target: string,
  canForward: (id: string) => boolean,
): IngressRoute | null {
  const previous = new Map<string, { from: string; connection: string } | null>();
  const queue: string[] = [];
  for (const start of starts) {
    previous.set(start, null);
    queue.push(start);
  }
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] as string;
    if (current === target) return buildRoute(previous, target);
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

/** A route to an intermediate component, then on from it. */
function joinRoutes(first: IngressRoute, second: IngressRoute): IngressRoute {
  return {
    components: [...first.components, ...second.components.slice(1)],
    connections: [...first.connections, ...second.connections],
  };
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
 * steps for it that a request can reach, in any flow.
 */
export function queuesFor(event: string, attempt: Attempt): Set<string> {
  const queues = new Set<string>();
  for (const flow of attempt.flows) {
    for (const id of liveStepIds(flow, attempt)) {
      const step = flow.steps[id];
      if (step?.type === "call" && step.action === "queue.publish" && step.event === event) {
        queues.add(step.target);
      }
    }
  }
  return queues;
}

/**
 * How work reaches an operation's handler. Requests come from a client over
 * the ingress route; messages come from a queue that the handler consumes
 * (connected to a queue some flow publishes the event to, drawn either way:
 * the consumer polls it, or the queue delivers to it); scheduled jobs start
 * in the handler itself.
 */
export function findOperationRoute(
  operation: Operation,
  attempt: Attempt,
  catalog: CatalogIndex,
  handlerId: string,
): IngressRoute | null {
  const trigger = operation.trigger;
  if (trigger.type === "request") {
    return findIngressRoute(
      attempt.architecture,
      catalog,
      handlerId,
      operation.cacheableAtEdge ? "through-edge" : "around-edge",
    );
  }
  if (trigger.type === "schedule") return { components: [handlerId], connections: [] };
  const queues = queuesFor(trigger.event, attempt);
  const connection = [...attempt.architecture.connections]
    .sort((a, b) => a.id.localeCompare(b.id))
    .find(
      (c) =>
        (c.from === handlerId && queues.has(c.to)) || (c.to === handlerId && queues.has(c.from)),
    );
  if (!connection) return null;
  const queue = connection.from === handlerId ? connection.to : connection.from;
  return { components: [queue, handlerId], connections: [connection.id] };
}
