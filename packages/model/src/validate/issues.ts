export const ISSUE_CODES = [
  "duplicate-component-id",
  "duplicate-connection-id",
  "duplicate-flow",
  "unknown-kind",
  "unknown-flavor",
  "unknown-size",
  "replicas-not-supported",
  "shards-not-supported",
  "replicas-ignored",
  "zones-ignored",
  "zones-exceed-instances",
  "regions-ignored",
  "autoscale-not-supported",
  "autoscale-below-minimum",
  "in-process-shared",
  "connection-unknown-endpoint",
  "connection-self-loop",
  "connection-duplicate",
  "data-unknown-entity",
  "data-not-supported",
  "flow-unknown-operation",
  "flow-unknown-handler",
  "flow-handler-not-compute",
  "flow-handler-unreachable",
  "flow-root-missing",
  "flow-cycle",
  "flow-empty",
  "step-unknown-target",
  "step-no-connection",
  "step-async-connection",
  "step-action-not-supported",
  "step-entity-required",
  "step-unknown-entity",
  "step-entity-not-stored",
  "step-missing-param",
  "step-unexpected-param",
  "step-unknown-event",
  "flow-consumer-idle",
  "step-batch-in-request",
  "step-aggregate-in-request",
  "step-logic-not-offered",
  "step-logic-needs-component",
  "step-unknown-count",
  "step-outbox-without-transaction",
  "step-exactly-once-unsupported",
  "step-ttl-unsupported",
  "step-unknown-outcome",
  "step-next-missing",
  "step-unhandled-outcome",
  "step-infeasible-outcome",
  "step-unreachable",
  "decision-unknown",
  "decision-unknown-option",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export type IssueLocation =
  | { readonly type: "component"; readonly componentId: string }
  | { readonly type: "connection"; readonly connectionId: string }
  | { readonly type: "flow"; readonly operation: string }
  | {
      readonly type: "step";
      readonly operation: string;
      readonly stepId: string;
      readonly outcome?: string;
    }
  | { readonly type: "decision"; readonly decision: string };

export interface Issue {
  /** Errors make an attempt not evaluable; warnings are reported but do not block. */
  readonly severity: "error" | "warning";
  readonly code: IssueCode;
  readonly message: string;
  readonly location: IssueLocation;
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}
