import { ACTIONS, LOGIC } from "@archdrill/model";
import type { Path, PathStep } from "./types";

/** Human-readable label of one step's outcome, e.g. `cache get: miss`. */
export function describeStep(step: PathStep): string {
  if (step.kind === "logic") return `${LOGIC[step.logic].label}: ${step.outcome}`;
  return `${ACTIONS[step.action].label}: ${step.outcome}`;
}

/** Compact outcome sequence, e.g. `miss → found → valid → ok → 302`. */
export function describePath(path: Path): string {
  const outcomes = path.steps.map((step) => step.outcome);
  const end = path.terminal.kind === "respond" ? String(path.terminal.status) : "unhandled";
  return [...outcomes, end].join(" → ");
}
