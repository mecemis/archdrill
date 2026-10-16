import type { Attempt, Component, Connection, ConnectionPolicy } from "./schema";

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function componentChanges(before: Component, after: Component): string[] {
  const changes: string[] = [];
  if (before.flavor !== after.flavor) changes.push(`${before.flavor} → ${after.flavor}`);
  if (before.size !== after.size)
    changes.push(`size ${before.size ?? "default"} → ${after.size ?? "default"}`);
  if (before.shards !== after.shards) changes.push(`shards ${before.shards} → ${after.shards}`);
  if (before.replicas !== after.replicas)
    changes.push(`replicas ${before.replicas} → ${after.replicas}`);
  if (before.zones !== after.zones) changes.push(`zones ${before.zones} → ${after.zones}`);
  if (!sameJson(before.autoscale, after.autoscale)) {
    changes.push(after.autoscale ? `autoscaling up to ${after.autoscale.max}` : "no autoscaling");
  }
  if (!sameJson(before.data, after.data)) changes.push("stored entities changed");
  return changes;
}

function policySummary(policy: ConnectionPolicy): string {
  const parts = [
    policy.timeoutMs !== undefined ? `timeout ${policy.timeoutMs} ms` : "no timeout",
    policy.retries > 0 ? `${policy.retries} retries` : null,
    policy.circuitBreaker ? "circuit breaker" : null,
    policy.maxRps !== undefined ? `bulkhead ${policy.maxRps}/s` : null,
    policy.sameZone ? "same-zone routing" : null,
  ];
  return parts.filter((p): p is string => p !== null).join(", ");
}

/**
 * What changed between two versions of a design, in short sentences: the
 * components, connections, call policies, flows and decisions.
 */
export function describeChanges(before: Attempt, after: Attempt): string[] {
  const lines: string[] = [];
  const label = (attempt: Attempt, id: string) =>
    attempt.architecture.components.find((c) => c.id === id)?.label ?? id;
  const route = (attempt: Attempt, c: Connection) =>
    `${label(attempt, c.from)} → ${label(attempt, c.to)}`;

  const oldComponents = new Map(before.architecture.components.map((c) => [c.id, c]));
  const newComponents = new Map(after.architecture.components.map((c) => [c.id, c]));
  for (const [id, c] of newComponents) {
    const old = oldComponents.get(id);
    if (!old) lines.push(`Added ${c.label}`);
    else {
      const changes = componentChanges(old, c);
      if (changes.length > 0) lines.push(`${c.label}: ${changes.join(", ")}`);
    }
  }
  for (const [id, c] of oldComponents) if (!newComponents.has(id)) lines.push(`Removed ${c.label}`);

  const oldConnections = new Map(before.architecture.connections.map((c) => [c.id, c]));
  const newConnections = new Map(after.architecture.connections.map((c) => [c.id, c]));
  for (const [id, c] of newConnections) {
    const old = oldConnections.get(id);
    if (!old) lines.push(`Connected ${route(after, c)}`);
    else if (!sameJson(old.policy, c.policy))
      lines.push(`${route(after, c)}: ${policySummary(c.policy)}`);
  }
  for (const [id, c] of oldConnections) {
    if (!newConnections.has(id)) lines.push(`Disconnected ${route(before, c)}`);
  }

  for (const flow of after.flows) {
    const old = before.flows.find((f) => f.operation === flow.operation);
    if (!old) {
      lines.push(`Recorded the ${flow.operation} flow`);
      continue;
    }
    const added = Object.keys(flow.steps).filter((id) => !(id in old.steps)).length;
    const removed = Object.keys(old.steps).filter((id) => !(id in flow.steps)).length;
    const edited = Object.keys(flow.steps).filter(
      (id) => id in old.steps && !sameJson(old.steps[id], flow.steps[id]),
    ).length;
    const parts = [
      old.handler !== flow.handler ? `handled by ${label(after, flow.handler)}` : null,
      added > 0 ? `${added} step${added === 1 ? "" : "s"} added` : null,
      removed > 0 ? `${removed} removed` : null,
      edited > 0 ? `${edited} changed` : null,
    ].filter((p): p is string => p !== null);
    if (parts.length > 0) lines.push(`${flow.operation} flow: ${parts.join(", ")}`);
  }
  for (const flow of before.flows) {
    if (!after.flows.some((f) => f.operation === flow.operation)) {
      lines.push(`Removed the ${flow.operation} flow`);
    }
  }

  const decisions = new Set([...Object.keys(before.decisions), ...Object.keys(after.decisions)]);
  for (const id of decisions) {
    const a = before.decisions[id];
    const b = after.decisions[id];
    if (a !== b) lines.push(`Decision ${id}: ${a ?? "undecided"} → ${b ?? "undecided"}`);
  }
  return lines;
}
