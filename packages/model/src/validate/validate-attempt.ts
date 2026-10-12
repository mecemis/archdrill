import type { Attempt, CallStep, Component, Flow, Step } from "../attempt/schema";
import {
  feasibleOutcomes,
  findCycle,
  liveStepIds,
  stepOutcomes,
  unhandledOutcomes,
} from "../attempt/steps";
import { ACTIONS, actionTakesParam, CONDITIONAL_OUTCOMES } from "../catalog/actions";
import type { CatalogIndex } from "../catalog/schema";
import { findIngressRoute } from "../graph/ingress";
import type { Problem } from "../problem/schema";
import type { Issue } from "./issues";

export interface ValidationContext {
  readonly catalog: CatalogIndex;
  readonly problem: Problem;
}

/**
 * Referential and semantic validation of an attempt. Never throws; every issue
 * carries a location the UI can highlight.
 */
export function validateAttempt(attempt: Attempt, ctx: ValidationContext): Issue[] {
  return [
    ...validateComponents(attempt, ctx),
    ...validateConnections(attempt),
    ...validateFlows(attempt, ctx),
    ...validateDecisions(attempt, ctx.problem),
  ];
}

function validateComponents(attempt: Attempt, ctx: ValidationContext): Issue[] {
  const issues: Issue[] = [];
  const entities = new Set(ctx.problem.entities.map((e) => e.name));
  const seen = new Set<string>();
  for (const component of attempt.architecture.components) {
    const location = { type: "component", componentId: component.id } as const;
    if (seen.has(component.id)) {
      issues.push(
        error("duplicate-component-id", `Duplicate component id "${component.id}".`, location),
      );
    }
    seen.add(component.id);
    issues.push(...validateComponentCatalog(component, ctx.catalog));
    const kind = ctx.catalog.kind(component.kind);
    for (const binding of component.data) {
      if (!entities.has(binding.entity)) {
        issues.push(
          error(
            "data-unknown-entity",
            `"${component.label}" stores unknown entity "${binding.entity}".`,
            location,
          ),
        );
      } else if (kind && !kind.holdsData) {
        issues.push(
          error("data-not-supported", `"${component.label}" cannot store entities.`, location),
        );
      }
    }
  }
  return issues;
}

function validateComponentCatalog(component: Component, catalog: CatalogIndex): Issue[] {
  const location = { type: "component", componentId: component.id } as const;
  const kind = catalog.kind(component.kind);
  if (!kind)
    return [error("unknown-kind", `Unknown component kind "${component.kind}".`, location)];
  const flavor = catalog.flavor(component.kind, component.flavor);
  if (!flavor) {
    return [
      error("unknown-flavor", `Unknown flavor "${component.flavor}" for ${kind.label}.`, location),
    ];
  }
  const issues: Issue[] = [];
  if (component.size !== undefined && !(component.size in flavor.sizes)) {
    issues.push(
      error("unknown-size", `Unknown size "${component.size}" for ${flavor.label}.`, location),
    );
  }
  if (!kind.shardable && component.shards > 1) {
    issues.push(error("shards-not-supported", `${kind.label} cannot be sharded.`, location));
  }
  if (flavor.managedRedundancy && component.replicas > 1) {
    issues.push(
      warning(
        "replicas-ignored",
        `${flavor.label} is managed and redundant; its replica count is ignored.`,
        location,
      ),
    );
  }
  if (!kind.replicable && component.replicas > 1) {
    issues.push(error("replicas-not-supported", `${kind.label} does not take replicas.`, location));
  }
  return issues;
}

function validateConnections(attempt: Attempt): Issue[] {
  const issues: Issue[] = [];
  const componentIds = new Set(attempt.architecture.components.map((c) => c.id));
  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const conn of attempt.architecture.connections) {
    const location = { type: "connection", connectionId: conn.id } as const;
    if (ids.has(conn.id)) {
      issues.push(
        error("duplicate-connection-id", `Duplicate connection id "${conn.id}".`, location),
      );
    }
    ids.add(conn.id);
    if (!componentIds.has(conn.from) || !componentIds.has(conn.to)) {
      issues.push(
        error(
          "connection-unknown-endpoint",
          `Connection "${conn.id}" references a missing component.`,
          location,
        ),
      );
      continue;
    }
    if (conn.from === conn.to) {
      issues.push(
        error(
          "connection-self-loop",
          `Connection "${conn.id}" connects a component to itself.`,
          location,
        ),
      );
    }
    const pair = `${conn.from}->${conn.to}`;
    if (pairs.has(pair)) {
      issues.push(
        error(
          "connection-duplicate",
          `More than one connection from "${conn.from}" to "${conn.to}".`,
          location,
        ),
      );
    }
    pairs.add(pair);
  }
  return issues;
}

function validateFlows(attempt: Attempt, ctx: ValidationContext): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const flow of attempt.flows) {
    if (seen.has(flow.operation)) {
      issues.push(
        error("duplicate-flow", `More than one flow for "${flow.operation}".`, {
          type: "flow",
          operation: flow.operation,
        }),
      );
    }
    seen.add(flow.operation);
    issues.push(...validateFlow(flow, attempt, ctx));
  }
  return issues;
}

function validateFlow(flow: Flow, attempt: Attempt, ctx: ValidationContext): Issue[] {
  const location = { type: "flow", operation: flow.operation } as const;
  if (!ctx.problem.operations.some((op) => op.id === flow.operation)) {
    return [error("flow-unknown-operation", `Unknown operation "${flow.operation}".`, location)];
  }
  const handler = attempt.architecture.components.find((c) => c.id === flow.handler);
  if (!handler) {
    return [
      error("flow-unknown-handler", `The handler of "${flow.operation}" does not exist.`, location),
    ];
  }
  const issues: Issue[] = [];
  if (!ctx.catalog.capabilities(handler.kind, handler.flavor).has("stateless-compute")) {
    issues.push(
      error(
        "flow-handler-not-compute",
        `"${handler.label}" cannot handle requests; pick a service.`,
        location,
      ),
    );
  }
  if (!findIngressRoute(attempt.architecture, ctx.catalog, handler.id)) {
    issues.push(
      error(
        "flow-handler-unreachable",
        `No client can reach "${handler.label}". Connect a client to it, directly or through a load balancer.`,
        location,
      ),
    );
  }
  issues.push(...validateFlowGraph(flow, attempt));
  for (const [stepId, step] of Object.entries(flow.steps)) {
    if (step.type === "call") issues.push(...validateCallStep(flow, stepId, step, attempt, ctx));
  }
  return issues;
}

function validateFlowGraph(flow: Flow, attempt: Attempt): Issue[] {
  const flowLocation = { type: "flow", operation: flow.operation } as const;
  if (flow.root === null) {
    return [
      warning("flow-empty", `The flow for "${flow.operation}" has no steps yet.`, flowLocation),
    ];
  }
  if (!(flow.root in flow.steps)) {
    return [
      error(
        "flow-root-missing",
        `The first step of "${flow.operation}" does not exist.`,
        flowLocation,
      ),
    ];
  }
  const issues: Issue[] = [];
  for (const [stepId, step] of Object.entries(flow.steps)) {
    if (step.type === "respond") continue;
    const outcomes = new Set(stepOutcomes(step));
    for (const [outcome, target] of Object.entries(step.next)) {
      const loc = { type: "step", operation: flow.operation, stepId, outcome } as const;
      if (!outcomes.has(outcome)) {
        issues.push(
          error("step-unknown-outcome", `Step ${stepId} has no outcome "${outcome}".`, loc),
        );
      } else if (!(target in flow.steps)) {
        issues.push(
          error(
            "step-next-missing",
            `Outcome "${outcome}" of step ${stepId} points to a missing step.`,
            loc,
          ),
        );
      }
    }
  }
  const cycle = findCycle(flow);
  if (cycle) {
    issues.push(
      error(
        "flow-cycle",
        `Steps form a loop (${cycle.join(" → ")}). Express retries as connection policy.`,
        flowLocation,
      ),
    );
  }
  const live = new Set(liveStepIds(flow, attempt));
  for (const [stepId, step] of Object.entries(flow.steps)) {
    const loc = { type: "step", operation: flow.operation, stepId } as const;
    if (!live.has(stepId)) {
      issues.push(
        warning("step-unreachable", `Step ${stepId} is never reached by a request.`, loc),
      );
      continue;
    }
    issues.push(...infeasibleLinks(flow, stepId, step, attempt));
    for (const outcome of unhandledOutcomes(step, attempt)) {
      issues.push(
        warning(
          "step-unhandled-outcome",
          `Outcome "${outcome}" of step ${stepId} is not handled.`,
          { ...loc, outcome },
        ),
      );
    }
  }
  return issues;
}

/** Links on outcomes that this design can never produce, e.g. a negative hit without negative caching. */
function infeasibleLinks(flow: Flow, stepId: string, step: Step, attempt: Attempt): Issue[] {
  if (step.type !== "call") return [];
  const feasible = new Set(feasibleOutcomes(step, attempt));
  return Object.keys(step.next)
    .filter((outcome) => stepOutcomes(step).includes(outcome) && !feasible.has(outcome))
    .map((outcome) => {
      const enabling = CONDITIONAL_OUTCOMES[step.action]?.[outcome];
      const reason = enabling
        ? ` until a reachable step performs ${enabling} on the same component and entity`
        : "";
      return warning(
        "step-infeasible-outcome",
        `Outcome "${outcome}" of step ${stepId} can never happen${reason}.`,
        { type: "step", operation: flow.operation, stepId, outcome },
      );
    });
}

function validateCallStep(
  flow: Flow,
  stepId: string,
  step: CallStep,
  attempt: Attempt,
  ctx: ValidationContext,
): Issue[] {
  const loc = { type: "step", operation: flow.operation, stepId } as const;
  const target = attempt.architecture.components.find((c) => c.id === step.target);
  if (!target)
    return [error("step-unknown-target", `Step ${stepId} calls a missing component.`, loc)];
  const issues: Issue[] = [];
  const connection = attempt.architecture.connections.find(
    (c) => c.from === flow.handler && c.to === step.target,
  );
  if (!connection) {
    issues.push(
      error(
        "step-no-connection",
        `Step ${stepId} calls "${target.label}" but there is no connection to it.`,
        loc,
      ),
    );
  } else if (connection.mode !== "sync") {
    issues.push(
      error(
        "step-async-connection",
        `Step ${stepId} needs a synchronous connection to "${target.label}".`,
        loc,
      ),
    );
  }
  const action = ACTIONS[step.action];
  if (!ctx.catalog.capabilities(target.kind, target.flavor).has(action.capability)) {
    issues.push(
      error("step-action-not-supported", `"${target.label}" does not support ${step.action}.`, loc),
    );
  }
  if (action.effect !== "allocate") {
    issues.push(...validateStepEntity(stepId, step, target, loc, ctx));
  } else if (step.entity !== undefined) {
    issues.push(
      error(
        "step-unexpected-param",
        `Step ${stepId} (${step.action}) hands out keys and does not take an entity.`,
        loc,
      ),
    );
  }
  if (step.batchSize !== undefined && !actionTakesParam(step.action, "batchSize")) {
    issues.push(
      error(
        "step-unexpected-param",
        `Step ${stepId} (${step.action}) does not take a batch size.`,
        loc,
      ),
    );
  }
  for (const param of action.params) {
    if (step[param] === undefined) {
      issues.push(
        error("step-missing-param", `Step ${stepId} (${step.action}) needs ${param}.`, loc),
      );
    }
  }
  return issues;
}

function validateStepEntity(
  stepId: string,
  step: CallStep,
  target: Component,
  loc: Issue["location"],
  ctx: ValidationContext,
): Issue[] {
  if (step.entity === undefined) {
    return [
      error("step-entity-required", `Step ${stepId} must say which entity it works on.`, loc),
    ];
  }
  if (!ctx.problem.entities.some((e) => e.name === step.entity)) {
    return [
      error("step-unknown-entity", `Step ${stepId} uses unknown entity "${step.entity}".`, loc),
    ];
  }
  const durable = ACTIONS[step.action].capability !== "volatile-kv";
  if (durable && !target.data.some((d) => d.entity === step.entity)) {
    return [
      error(
        "step-entity-not-stored",
        `"${target.label}" does not store ${step.entity}. Bind the entity to it in the inspector.`,
        loc,
      ),
    ];
  }
  return [];
}

function validateDecisions(attempt: Attempt, problem: Problem): Issue[] {
  const issues: Issue[] = [];
  for (const [decision, option] of Object.entries(attempt.decisions)) {
    const point = problem.decisionPoints.find((d) => d.id === decision);
    const location = { type: "decision", decision } as const;
    if (!point) {
      issues.push(error("decision-unknown", `Unknown decision "${decision}".`, location));
    } else if (!point.options.some((o) => o.id === option)) {
      issues.push(
        error(
          "decision-unknown-option",
          `"${option}" is not an option for "${decision}".`,
          location,
        ),
      );
    }
  }
  return issues;
}

function error(code: Issue["code"], message: string, location: Issue["location"]): Issue {
  return { severity: "error", code, message, location };
}

function warning(code: Issue["code"], message: string, location: Issue["location"]): Issue {
  return { severity: "warning", code, message, location };
}
