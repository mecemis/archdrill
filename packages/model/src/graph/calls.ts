import type { Attempt } from "../attempt/schema";
import { ACTIONS } from "../catalog/actions";
import { onlyServesObjects } from "../catalog/capabilities";
import type { CatalogIndex } from "../catalog/schema";

const actions = Object.values(ACTIONS);
const PUBLISH = ACTIONS["queue.publish"].capability;

/**
 * Components a handler's steps can call: anything that offers an action,
 * connected to it or not (a step can connect it). Clients only send
 * requests, an in-process component lives in the one service using it, and
 * object storage, answering with the object or storing it, calls nothing.
 */
export function callableFrom(handler: string, attempt: Attempt, catalog: CatalogIndex): string[] {
  const self = attempt.architecture.components.find((c) => c.id === handler);
  if (self && onlyServesObjects(catalog.capabilities(self.kind, self.flavor))) return [];
  return attempt.architecture.components
    .filter((c) => {
      if (c.id === handler) return false;
      const caps = catalog.capabilities(c.kind, c.flavor);
      if (caps.has("traffic-source") || !actions.some((a) => caps.has(a.capability))) return false;
      const users = attempt.architecture.connections.filter((x) => x.to === c.id);
      return !catalog.kind(c.kind)?.inProcess || users.every((x) => x.from === handler);
    })
    .map((c) => c.id);
}

/**
 * How a handler gets a connection to call a component over: none needed, a
 * new one, or, for a queue that already delivers to it, the same one turned
 * round (a consumer's queue is found whichever way the connection points).
 */
export function connectionToCall(
  handler: string,
  target: string,
  attempt: Attempt,
  catalog: CatalogIndex,
):
  | { readonly kind: "connected" }
  | { readonly kind: "add" }
  | { readonly kind: "reverse"; readonly id: string } {
  const connections = attempt.architecture.connections;
  if (connections.some((c) => c.from === handler && c.to === target)) return { kind: "connected" };
  const back = connections.find((c) => c.from === target && c.to === handler);
  const component = attempt.architecture.components.find((c) => c.id === target);
  const queue = component && catalog.capabilities(component.kind, component.flavor).has(PUBLISH);
  return back && queue ? { kind: "reverse", id: back.id } : { kind: "add" };
}
