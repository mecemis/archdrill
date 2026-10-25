import type { Analysis } from "@archdrill/engine";

/** Parts of a design that only operations outside the focus use. */
export interface OutOfFocus {
  readonly components: ReadonlySet<string>;
  readonly connections: ReadonlySet<string>;
}

const NOTHING: OutOfFocus = { components: new Set(), connections: new Set() };

interface Parts {
  readonly components: Set<string>;
  readonly connections: Set<string>;
}

/** Everything the chosen operations' flows touch: handlers, ingress routes and every path. */
function partsUsedBy(analysis: Analysis, chosen: (operation: string) => boolean): Parts {
  const parts: Parts = { components: new Set(), connections: new Set() };
  for (const [id, operation] of analysis.operations) {
    if (!chosen(id) || !operation.flow) continue;
    parts.components.add(operation.flow.handler);
    for (const c of operation.ingress?.components ?? []) parts.components.add(c);
    for (const c of operation.ingress?.connections ?? []) parts.connections.add(c);
    for (const path of operation.paths) {
      for (const c of path.components) parts.components.add(c);
      for (const c of path.connections) parts.connections.add(c);
    }
  }
  return parts;
}

const without = (ids: ReadonlySet<string>, kept: ReadonlySet<string>) =>
  new Set([...ids].filter((id) => !kept.has(id)));

/**
 * What the canvas fades for a scenario: parts other operations use and the
 * focus operations do not. Parts no operation uses yet, such as a component
 * just added, stay in view, and nothing fades while the focus operations use
 * nothing at all.
 */
export function outOfFocus(analysis: Analysis, focus: readonly string[]): OutOfFocus {
  const inFocus = partsUsedBy(analysis, (id) => focus.includes(id));
  if (inFocus.components.size === 0) return NOTHING;
  const elsewhere = partsUsedBy(analysis, (id) => !focus.includes(id));
  return {
    components: without(elsewhere.components, inFocus.components),
    connections: without(elsewhere.connections, inFocus.connections),
  };
}
