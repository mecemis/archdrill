import type { Attempt } from "../attempt/schema";
import { applyCommand, type CommandArgs } from "../commands/index";
import { cacheAsideAttempt } from "./fixtures";

/** When the disable flow deletes the cached link, relative to storing the change. */
export type Invalidation = "delete-after-update" | "delete-before-update" | "none";

/** Cache-aside redirect plus disable-link: update the store, and delete the cache entry or not. */
export function disableLinkAttempt(invalidation: Invalidation): Attempt {
  let a = applyCommand(cacheAsideAttempt(), "createFlow", {
    operation: "disable-link",
    handler: "api",
  }).attempt;
  const add = (
    id: string,
    step: CommandArgs<"addStep">["step"],
    attach: CommandArgs<"addStep">["attach"],
  ) => {
    a = applyCommand(a, "addStep", { operation: "disable-link", id, step, attach }).attempt;
  };
  const at = (stepId: string, outcome: string) => ({ to: "outcome" as const, stepId, outcome });
  const del = {
    type: "call" as const,
    target: "redis",
    action: "cache.delete" as const,
    entity: "Link",
  };
  const update = {
    type: "call" as const,
    target: "db",
    action: "store.update" as const,
    entity: "Link",
  };
  if (invalidation === "delete-before-update") {
    add("del", del, { to: "root" });
    add("update", update, at("del", "ok"));
    a = applyCommand(a, "linkOutcome", {
      operation: "disable-link",
      stepId: "del",
      outcome: "error",
      target: "update",
    }).attempt;
    add("r204", { type: "respond", status: 204 }, at("update", "ok"));
  } else {
    add("update", update, { to: "root" });
    if (invalidation === "delete-after-update") {
      add("del", del, at("update", "ok"));
      add("r204", { type: "respond", status: 204 }, at("del", "ok"));
    } else {
      add("r204", { type: "respond", status: 204 }, at("update", "ok"));
    }
  }
  add("r404", { type: "respond", status: 404 }, at("update", "notFound"));
  add("r503", { type: "respond", status: 503 }, at("update", "error"));
  if (invalidation === "delete-after-update") {
    // A failed delete leaves the old version cached, so the caller must retry.
    a = applyCommand(a, "linkOutcome", {
      operation: "disable-link",
      stepId: "del",
      outcome: "error",
      target: "r503",
    }).attempt;
  }
  return a;
}
