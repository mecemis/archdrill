import type { Attempt, CallStep, Component, Flow, Step } from "../attempt/schema";
import {
  feasibleOutcomes,
  findCycle,
  liveStepIds,
  stepOutcomes,
  unhandledOutcomes,
} from "../attempt/steps";
import {
  ACTIONS,
  actionTakesEntity,
  actionTakesParam,
  CONDITIONAL_OUTCOMES,
} from "../catalog/actions";
import { canHandle } from "../catalog/capabilities";
import { getLogic, type LogicId } from "../catalog/logic";
import {
  type CatalogIndex,
  type Flavor,
  type Kind,
  placedInZones,
  runsInRegion,
} from "../catalog/schema";
import { findOperationRoute } from "../graph/ingress";
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
    ...validateInProcess(attempt, ctx),
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
  issues.push(...validateZones(component, kind, flavor));
  if (component.regions > 1 && !runsInRegion(kind, flavor)) {
    const why = kind.inProcess
      ? `${kind.label} lives in its service's instances, wherever they run`
      : `${flavor.label} does not run in the design's region`;
    issues.push(warning("regions-ignored", `${why}; its standby region is ignored.`, location));
  }
  if (component.autoscale) {
    if (!kind.replicable || kind.holdsData || flavor.managedRedundancy) {
      issues.push(
        error("autoscale-not-supported", `${flavor.label} does not autoscale here.`, location),
      );
    } else if (component.autoscale.max < component.replicas) {
      issues.push(
        error(
          "autoscale-below-minimum",
          `${component.label} scales to at most ${component.autoscale.max} instances, fewer than its minimum of ${component.replicas}.`,
          location,
        ),
      );
    }
  }
  return issues;
}

function validateZones(component: Component, kind: Kind, flavor: Flavor): Issue[] {
  if (component.zones === 1) return [];
  const location = { type: "component", componentId: component.id } as const;
  if (!placedInZones(kind, flavor)) {
    const why = flavor.managedRedundancy
      ? `${flavor.label} spans zones on its own`
      : `${kind.label} has no instances of its own to place`;
    return [warning("zones-ignored", `${why}; its zone count is ignored.`, location)];
  }
  const instances = component.replicas * component.shards;
  if (component.zones > instances) {
    return [
      error(
        "zones-exceed-instances",
        `${component.label} runs ${instances} instance${instances === 1 ? "" : "s"}, too few to spread over ${component.zones} zones.`,
        location,
      ),
    ];
  }
  return [];
}

/** An in-process component lives inside one service, so only that service can call it. */
function validateInProcess(attempt: Attempt, ctx: ValidationContext): Issue[] {
  return attempt.architecture.components.flatMap((component) => {
    if (!ctx.catalog.kind(component.kind)?.inProcess) return [];
    const callers = attempt.architecture.connections.filter((c) => c.to === component.id);
    if (callers.length <= 1) return [];
    return [
      error(
        "in-process-shared",
        `${component.label} runs inside one service; ${callers.length} components connect to it.`,
        { type: "component", componentId: component.id },
      ),
    ];
  });
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
  const operation = ctx.problem.operations.find((op) => op.id === flow.operation);
  if (!operation) {
    return [error("flow-unknown-operation", `Unknown operation "${flow.operation}".`, location)];
  }
  const handler = attempt.architecture.components.find((c) => c.id === flow.handler);
  if (!handler) {
    return [
      error("flow-unknown-handler", `The handler of "${flow.operation}" does not exist.`, location),
    ];
  }
  const issues: Issue[] = [];
  const capabilities = ctx.catalog.capabilities(handler.kind, handler.flavor);
  if (!canHandle(capabilities, operation.trigger.type === "event")) {
    issues.push(
      error(
        "flow-handler-not-compute",
        capabilities.has("stream-processing")
          ? `"${handler.label}" processes messages from a queue; ${operation.label} needs a service.`
          : `"${handler.label}" cannot handle requests; pick a service.`,
        location,
      ),
    );
  }
  if (!findOperationRoute(operation, attempt, ctx.catalog, handler.id)) {
    const trigger = operation.trigger;
    // A consumer that receives nothing never runs; the design can still be judged without it.
    issues.push(
      trigger.type === "event"
        ? warning(
            "flow-consumer-idle",
            `"${handler.label}" receives no ${trigger.event} messages, so this consumer never runs. Publish ${trigger.event} to a queue in another flow and connect "${handler.label}" to that queue.`,
            location,
          )
        : error(
            "flow-handler-unreachable",
            `No client can reach "${handler.label}". Connect a client to it, directly or through a load balancer.`,
            location,
          ),
    );
  }
  issues.push(...validateFlowGraph(flow, attempt));
  for (const [stepId, step] of Object.entries(flow.steps)) {
    if (step.type === "call") issues.push(...validateCallStep(flow, stepId, step, attempt, ctx));
    const offered = ctx.problem.logic;
    if (step.type === "logic" && offered !== undefined && !offered.includes(step.logic)) {
      issues.push(
        error(
          "step-logic-not-offered",
          `Step ${stepId} uses "${step.logic}", which this problem does not offer.`,
          { type: "step", operation: flow.operation, stepId },
        ),
      );
    }
    if (step.type === "logic") issues.push(...logicNeeds(flow, stepId, step.logic, attempt, ctx));
  }
  return issues;
}

/** A decision that rests on another component (a downloaded list) needs that component connected. */
function logicNeeds(
  flow: Flow,
  stepId: string,
  logic: LogicId,
  attempt: Attempt,
  ctx: ValidationContext,
): Issue[] {
  const needs = getLogic(logic).needs;
  if (!needs) return [];
  const components = attempt.architecture.components;
  const connected = attempt.architecture.connections.some((connection) => {
    if (connection.from !== flow.handler) return false;
    const target = components.find((c) => c.id === connection.to);
    return (
      target !== undefined &&
      ctx.catalog.capabilities(target.kind, target.flavor).has(needs.capability)
    );
  });
  if (connected) return [];
  const handler = components.find((c) => c.id === flow.handler)?.label ?? flow.handler;
  return [
    error(
      "step-logic-needs-component",
      `Step ${stepId} (${getLogic(logic).label}) needs ${needs.what}. Connect "${handler}" to one.`,
      { type: "step", operation: flow.operation, stepId },
    ),
  ];
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
  if (actionTakesEntity(step.action)) {
    issues.push(...validateStepEntity(stepId, step, target, loc, ctx));
  } else if (step.entity !== undefined) {
    issues.push(
      error(
        "step-unexpected-param",
        `Step ${stepId} (${step.action}) does not work on an entity.`,
        loc,
      ),
    );
  }
  if (step.event !== undefined && !ctx.problem.events.some((e) => e.id === step.event)) {
    issues.push(
      error("step-unknown-event", `Step ${stepId} publishes unknown event "${step.event}".`, loc),
    );
  }
  if (step.event !== undefined && !actionTakesParam(step.action, "event")) {
    issues.push(
      error(
        "step-unexpected-param",
        `Step ${stepId} (${step.action}) does not publish an event.`,
        loc,
      ),
    );
  }
  if (step.coalesce !== undefined && !actionTakesParam(step.action, "coalesce")) {
    issues.push(
      error(
        "step-unexpected-param",
        `Step ${stepId} (${step.action}) cannot coalesce; only store reads can.`,
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
  for (const [param, what] of NEW_PARAMS) {
    if (step[param] !== undefined && !actionTakesParam(step.action, param)) {
      issues.push(
        error(
          "step-unexpected-param",
          `Step ${stepId} (${step.action}) does not take ${what}.`,
          loc,
        ),
      );
    }
  }
  if (step.each !== undefined && !ctx.problem.counts.some((c) => c.id === step.each)) {
    issues.push(
      error(
        "step-unknown-count",
        `Step ${stepId} fans out over unknown count "${step.each}".`,
        loc,
      ),
    );
  }
  if (step.exactlyOnce) {
    const handler = attempt.architecture.components.find((c) => c.id === flow.handler);
    const processes =
      handler !== undefined &&
      ctx.catalog.capabilities(handler.kind, handler.flavor).has("stream-processing");
    const transactional = ctx.catalog.capabilities(target.kind, target.flavor).has("transactions");
    if (!processes || !transactional) {
      issues.push(
        error(
          "step-exactly-once-unsupported",
          `Step ${stepId} commits exactly once only from a stream processor into a store with transactions.`,
          loc,
        ),
      );
    }
  }
  if (
    step.ttlSec !== undefined &&
    action.capability !== "volatile-kv" &&
    !ctx.catalog.capabilities(target.kind, target.flavor).has("ttl")
  ) {
    issues.push(
      error(
        "step-ttl-unsupported",
        `"${target.label}" does not expire entries by itself, so step ${stepId} cannot set a TTL.`,
        loc,
      ),
    );
  }
  if (step.outbox && step.fireAndForget) {
    issues.push(
      error(
        "step-unexpected-param",
        `Step ${stepId} publishes through an outbox, which already keeps the request from waiting; drop fire-and-forget.`,
        loc,
      ),
    );
  }
  if (step.outbox && !writesTransactionallyBefore(flow, stepId, attempt, ctx)) {
    issues.push(
      error(
        "step-outbox-without-transaction",
        `Step ${stepId} publishes through an outbox, but no store write in a transactional store comes before it on every path.`,
        loc,
      ),
    );
  }
  if (step.bufferSize !== undefined && !step.fireAndForget) {
    issues.push(
      error(
        "step-unexpected-param",
        `Step ${stepId} only buffers messages when it publishes fire-and-forget.`,
        loc,
      ),
    );
  }
  const trigger = ctx.problem.operations.find((o) => o.id === flow.operation)?.trigger;
  if (step.aggregateSec !== undefined && trigger?.type === "request") {
    issues.push(
      error(
        "step-aggregate-in-request",
        `Step ${stepId} would hold the request until its aggregation window closes. Aggregate in a consumer instead.`,
        loc,
      ),
    );
  }
  // A fire-and-forget publish fills its batch in the background, and a fan-out
  // fills its batches with the request's own calls: neither waits for other requests.
  const waitsForBatch =
    action.effect !== "allocate" && !step.fireAndForget && step.each === undefined;
  if ((step.batchSize ?? 1) > 1 && waitsForBatch && trigger?.type === "request") {
    issues.push(
      error(
        "step-batch-in-request",
        `Step ${stepId} would wait for other requests to fill a batch. Batch in a consumer or a scheduled job instead.`,
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

/**
 * Whether every way into a step passes a write to a store with transactions,
 * which an outbox message can share a transaction with.
 */
function writesTransactionallyBefore(
  flow: Flow,
  stepId: string,
  attempt: Attempt,
  ctx: ValidationContext,
): boolean {
  const capabilitiesOf = (id: string) => {
    const step = flow.steps[id];
    if (step?.type !== "call") return null;
    const target = attempt.architecture.components.find((c) => c.id === step.target);
    return target ? ctx.catalog.capabilities(target.kind, target.flavor) : null;
  };
  const storeWrite = (id: string): boolean => {
    const step = flow.steps[id];
    return (
      step?.type === "call" &&
      STORE_WRITE_EFFECTS.has(ACTIONS[step.action].effect) &&
      capabilitiesOf(id)?.has("durable-store") === true
    );
  };
  // Walk backwards from the step: on every way in, the last store write before
  // it must be transactional and must have committed (its ok outcome).
  const parents = (id: string) =>
    Object.entries(flow.steps).flatMap(([pid, s]) =>
      s.type === "respond"
        ? []
        : Object.entries(s.next)
            .filter(([, to]) => to === id)
            .map(([outcome]) => ({ pid, outcome })),
    );
  const covered = (id: string, seen: Set<string>): boolean => {
    const from = parents(id);
    if (from.length === 0) return false;
    return from.every(({ pid, outcome }) => {
      if (seen.has(pid)) return true;
      if (storeWrite(pid))
        return outcome === "ok" && capabilitiesOf(pid)?.has("transactions") === true;
      return covered(pid, new Set([...seen, pid]));
    });
  };
  return covered(stepId, new Set([stepId]));
}

/** Effects that change a store, and that an outbox message can share a transaction with. */
const STORE_WRITE_EFFECTS: ReadonlySet<string> = new Set([
  "write",
  "conditional-write",
  "delete",
  "increment",
]);

/** Optional parameters checked the same way, with how messages name them. */
const NEW_PARAMS = [
  ["aggregateSec", "an aggregation window"],
  ["counterShards", "counter shards"],
  ["fireAndForget", "fire-and-forget"],
  ["bufferSize", "a buffer size"],
  ["each", "a count to fan out over"],
  ["idempotencyKey", "an idempotency key"],
  ["outbox", "a transactional outbox"],
  ["exactlyOnce", "exactly-once commits"],
  ["ttlSec", "a TTL"],
] as const;

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
  // Short-lived entities may live in memory-only stores; everything else needs a store that holds it.
  const entity = ctx.problem.entities.find((e) => e.name === step.entity);
  const inMemory =
    entity?.ephemeral === true &&
    ctx.catalog.capabilities(target.kind, target.flavor).has("volatile-kv");
  const durable = ACTIONS[step.action].capability !== "volatile-kv" && !inMemory;
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
