import type { Architecture } from "../attempt/schema";
import { INGRESS_CAPABILITIES } from "../catalog/capabilities";
import type { CatalogIndex } from "../catalog/schema";

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
