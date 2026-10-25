import type { Operation } from "@archdrill/model";
import { statusLabel } from "../ui/outcome";
import { activePack } from "./content";

/** Consumers and scheduled jobs: work that runs in the background, not for a waiting client. */
export function runsInBackground(operation: Operation | undefined): boolean {
  return operation !== undefined && operation.trigger.type !== "request";
}

export function eventLabel(eventId: string): string {
  return activePack.problem.events.find((e) => e.id === eventId)?.label ?? eventId;
}

/** How the operation starts, e.g. `POST /links`, `on Link created` or `scheduled job`. */
export function triggerSummary(operation: Operation): string {
  const trigger = operation.trigger;
  if (trigger.type === "event") return `on ${eventLabel(trigger.event)}`;
  if (trigger.type === "schedule") return "scheduled job";
  return `${operation.method ?? ""} ${operation.path ?? ""}`.trim();
}

/**
 * What a final status means. A consumer or job that answers 2xx is done
 * (the message is acknowledged); any other status leaves the item to be
 * tried again.
 */
export function respondLabel(status: number, background: boolean): string {
  if (!background) return statusLabel(status);
  return status >= 200 && status < 300 ? `${status} done` : `${status} try again later`;
}

/** The problem's operations, those the scenario focuses on first, each group in the problem's order. */
export function operationsFocusFirst(focus: readonly string[]): readonly Operation[] {
  const { operations } = activePack.problem;
  return [
    ...operations.filter((o) => focus.includes(o.id)),
    ...operations.filter((o) => !focus.includes(o.id)),
  ];
}

export function operationById(id: string): Operation | undefined {
  return activePack.problem.operations.find((o) => o.id === id);
}
