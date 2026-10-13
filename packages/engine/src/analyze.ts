import {
  type Attempt,
  type Flow,
  findOperationRoute,
  hasErrors,
  type IngressRoute,
  type Issue,
  type IssueCode,
  type Operation,
  type ValidationContext,
  validateAttempt,
} from "@archdrill/model";
import { enumeratePaths } from "./paths/enumerate";
import type { Path } from "./paths/types";

/** Issues that make a flow's graph impossible to walk. */
const STRUCTURAL_CODES: ReadonlySet<IssueCode> = new Set([
  "flow-unknown-operation",
  "flow-unknown-handler",
  "flow-root-missing",
  "flow-cycle",
  "step-next-missing",
  "step-unknown-outcome",
  "duplicate-flow",
]);

export type OperationStatus = "missing" | "empty" | "broken" | "ready";

export interface OperationAnalysis {
  readonly operation: Operation;
  readonly flow: Flow | undefined;
  readonly status: OperationStatus;
  readonly ingress: IngressRoute | null;
  readonly paths: readonly Path[];
  readonly truncated: boolean;
}

export interface Analysis {
  readonly issues: readonly Issue[];
  /** False when any validation error exists; evaluation then reports issues instead of scores. */
  readonly evaluable: boolean;
  readonly operations: ReadonlyMap<string, OperationAnalysis>;
  /** Component id → operations whose paths touch it. */
  readonly usage: ReadonlyMap<string, ReadonlySet<string>>;
  /** Components that no path of any operation touches, in declaration order. */
  readonly unusedComponents: readonly string[];
}

export function analyzeAttempt(attempt: Attempt, ctx: ValidationContext): Analysis {
  const issues = validateAttempt(attempt, ctx);
  const operations = new Map<string, OperationAnalysis>();
  for (const operation of ctx.problem.operations) {
    operations.set(operation.id, analyzeOperation(operation, attempt, ctx, issues));
  }
  const usage = componentUsage(attempt, operations);
  const unusedComponents = attempt.architecture.components
    .map((c) => c.id)
    .filter((id) => !usage.has(id));
  return { issues, evaluable: !hasErrors(issues), operations, usage, unusedComponents };
}

function analyzeOperation(
  operation: Operation,
  attempt: Attempt,
  ctx: ValidationContext,
  issues: readonly Issue[],
): OperationAnalysis {
  const flow = attempt.flows.find((f) => f.operation === operation.id);
  const base = { operation, flow, ingress: null, paths: [], truncated: false };
  if (!flow) return { ...base, status: "missing" };
  const broken = issues.some(
    (issue) =>
      STRUCTURAL_CODES.has(issue.code) &&
      "operation" in issue.location &&
      issue.location.operation === operation.id,
  );
  if (broken) return { ...base, status: "broken" };
  const ingress = findOperationRoute(operation, attempt, ctx.catalog, flow.handler);
  if (flow.root === null) return { ...base, ingress, status: "empty" };
  const { paths, truncated } = enumeratePaths(flow, attempt, ingress);
  return { operation, flow, ingress, paths, truncated, status: "ready" };
}

function componentUsage(
  attempt: Attempt,
  operations: ReadonlyMap<string, OperationAnalysis>,
): Map<string, Set<string>> {
  const usage = new Map<string, Set<string>>();
  const mark = (componentId: string, operation: string) => {
    const set = usage.get(componentId) ?? new Set<string>();
    set.add(operation);
    usage.set(componentId, set);
  };
  for (const analysis of operations.values()) {
    if (!analysis.flow) continue;
    mark(analysis.flow.handler, analysis.operation.id);
    for (const id of analysis.ingress?.components ?? []) mark(id, analysis.operation.id);
    for (const path of analysis.paths) {
      for (const id of path.components) mark(id, analysis.operation.id);
    }
  }
  const known = new Set(attempt.architecture.components.map((c) => c.id));
  for (const id of usage.keys()) if (!known.has(id)) usage.delete(id);
  return usage;
}
