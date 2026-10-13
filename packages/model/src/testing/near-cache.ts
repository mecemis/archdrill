import type { Attempt } from "../attempt/schema";
import { applyCommand, type CommandArgs, type CommandName } from "../commands/index";

function apply<N extends CommandName>(attempt: Attempt, name: N, args: CommandArgs<N>): Attempt {
  return applyCommand(attempt, name, args).attempt;
}

/** Adds an in-process cache in front of Redis, filled from Redis hits with a 10 s TTL. */
export function withNearCache(base: Attempt, ttlSec = 10): Attempt {
  let a = apply(base, "addComponent", {
    id: "near",
    kind: "near-cache",
    flavor: "lru",
    label: "Near cache",
    position: { x: 0, y: 0 },
  });
  a = apply(a, "addConnection", { from: "api", to: "near" });
  a = apply(a, "addStep", {
    operation: "redirect",
    id: "near-get",
    step: { type: "call", target: "near", action: "cache.get", entity: "Link" },
    attach: { to: "root" },
    continueWith: { outcome: "miss" },
  });
  a = apply(a, "linkOutcome", {
    operation: "redirect",
    stepId: "near-get",
    outcome: "hit",
    target: "expiryHit",
  });
  a = apply(a, "linkOutcome", {
    operation: "redirect",
    stepId: "near-get",
    outcome: "error",
    target: "get",
  });
  a = apply(a, "addStep", {
    operation: "redirect",
    id: "near-set",
    step: { type: "call", target: "near", action: "cache.set", entity: "Link", ttlSec },
    attach: { to: "outcome", stepId: "get", outcome: "hit" },
    continueWith: { outcome: "ok" },
  });
  return apply(a, "linkOutcome", {
    operation: "redirect",
    stepId: "near-set",
    outcome: "error",
    target: "expiryHit",
  });
}
