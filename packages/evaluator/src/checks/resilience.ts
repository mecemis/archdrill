import type { CallPathStep } from "@archdrill/engine";
import {
  ACTIONS,
  type Capability,
  CapabilitySchema,
  type Component,
  type Connection,
  getAction,
  MAX_RETRIES,
} from "@archdrill/model";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { type CheckContext, defineCheck, failed, graded, notApplicable, passed } from "./types";

/** Share of an overloaded component's load that, when it is retries, makes a retry storm. */
const RETRY_STORM_SHARE = 0.2;

interface CalledConnection {
  readonly connection: Connection;
  readonly target: Component;
  readonly steps: readonly { readonly operation: string; readonly step: CallPathStep }[];
}

/** Connections that flow steps call over, optionally only to targets that pass `accept`. */
function calledConnections(
  ctx: CheckContext,
  accept: (target: Component) => boolean = () => true,
  operation?: string,
): CalledConnection[] {
  const byId = new Map<string, CalledConnection>();
  for (const op of ctx.analysis.operations.values()) {
    if (operation && op.operation.id !== operation) continue;
    for (const path of op.paths) {
      for (const step of path.steps) {
        if (step.kind !== "call" || step.connectionId === null) continue;
        const connection = ctx.attempt.architecture.connections.find(
          (c) => c.id === step.connectionId,
        );
        const target = ctx.attempt.architecture.components.find((c) => c.id === step.target);
        if (!connection || !target || !accept(target)) continue;
        const entry = byId.get(connection.id) ?? { connection, target, steps: [] };
        byId.set(connection.id, {
          ...entry,
          steps: [...entry.steps, { operation: path.operation, step }],
        });
      }
    }
  }
  return [...byId.values()];
}

const hasCapability = (ctx: CheckContext, capability: Capability) => (c: Component) =>
  ctx.catalog.capabilities(c.kind, c.flavor).has(capability);

const connectionEvidence = (called: readonly CalledConnection[]): Evidence[] =>
  called.map((c) => ({ type: "connection", connectionId: c.connection.id }));

const ms = (value: number) => `${value.toLocaleString("en-US")} ms`;

/** Calls to a kind of dependency give up quickly enough that its failure cannot eat the latency budget. */
export const dependencyTimeoutBounded = defineCheck({
  id: "dependency-timeout-bounded",
  description: "Calls to a dependency time out quickly enough to protect the latency budget.",
  params: z.strictObject({ capability: CapabilitySchema, maxMs: z.number().positive() }),
  run(params, ctx) {
    const called = calledConnections(ctx, hasCapability(ctx, params.capability));
    if (called.length === 0)
      return notApplicable(`No flow calls a ${params.capability} dependency.`);
    const problems = called.flatMap(({ connection, target }) => {
      const timeout = connection.policy.timeoutMs;
      if (timeout === undefined)
        return [`${target.label}: no timeout, so a hung call waits for the client default (30 s)`];
      if (timeout > params.maxMs) return [`${target.label}: waits up to ${ms(timeout)}`];
      return [];
    });
    if (problems.length === 0) {
      const labels = called.map((c) => c.target.label).join(", ");
      return passed(`Calls to ${labels} give up within ${ms(params.maxMs)}.`);
    }
    const bad = called.filter(
      (c) => (c.connection.policy.timeoutMs ?? Number.POSITIVE_INFINITY) > params.maxMs,
    );
    return graded(
      called.length - bad.length,
      called.length,
      `${bad.length} of ${called.length} connection(s) to ${params.capability} dependencies can wait longer than ${ms(params.maxMs)}.`,
      connectionEvidence(bad),
      problems,
    );
  },
});

/** Retries are few, spaced out exponentially and randomised, so they cannot synchronise into a storm. */
export const retriesBoundedWithJitter = defineCheck({
  id: "retries-bounded-with-jitter",
  description: "Retries are bounded and use exponential backoff with jitter.",
  params: z.strictObject({ maxRetries: z.number().int().min(0).max(MAX_RETRIES).default(3) }),
  run(params, ctx) {
    const retrying = calledConnections(ctx).filter((c) => c.connection.policy.retries > 0);
    if (retrying.length === 0) return passed("No dependency call is retried.");
    const problems = retrying.flatMap(({ connection, target }) => {
      const { retries, backoff, jitter } = connection.policy;
      const issues = [
        retries > params.maxRetries ? `${retries} retries (more than ${params.maxRetries})` : null,
        backoff === "none" ? "no backoff" : null,
        backoff !== "none" && !jitter ? "no jitter" : null,
      ].filter((i): i is string => i !== null);
      return issues.length > 0
        ? [{ connection, line: `${target.label}: ${issues.join(", ")}` }]
        : [];
    });
    if (problems.length === 0) {
      return passed(
        `All ${retrying.length} retrying connection(s) back off exponentially with jitter.`,
      );
    }
    return graded(
      retrying.length - problems.length,
      retrying.length,
      "Some retries can hammer a struggling dependency in lockstep.",
      problems.map((p) => ({ type: "connection", connectionId: p.connection.id })),
      problems.map((p) => p.line),
    );
  },
});

/** Calls whose retry can change the outcome (a conditional insert) are not retried blindly. */
export const retryOnlyIdempotent = defineCheck({
  id: "retry-only-idempotent",
  description: "Calls that are unsafe to retry are not retried.",
  params: z.strictObject({ operation: z.string().min(1) }),
  run(params, ctx) {
    const unsafe = calledConnections(ctx, () => true, params.operation).flatMap(
      ({ connection, target, steps }) =>
        connection.policy.retries > 0
          ? steps
              .filter(({ step }) => getAction(step.action).unsafeToRetry)
              .map(({ step }) => ({ connection, target, step }))
          : [],
    );
    if (unsafe.length === 0) return passed("No call that is unsafe to retry is retried.");
    const first = unsafe[0];
    if (!first) return passed("No call that is unsafe to retry is retried.");
    const evidence: Evidence[] = unsafe.flatMap(({ connection, step }) => [
      { type: "connection", connectionId: connection.id },
      { type: "step", operation: params.operation, stepId: step.stepId },
    ]);
    return failed(
      `${first.target.label} · ${ACTIONS[first.step.action].label} is retried. ${getAction(first.step.action).unsafeToRetry}`,
      evidence,
    );
  },
});

/** Calls to a kind of dependency go through a circuit breaker. */
export const circuitBreakerOnDependency = defineCheck({
  id: "circuit-breaker-on-dependency",
  description: "Calls to a dependency go through a circuit breaker.",
  params: z.strictObject({ capability: CapabilitySchema }),
  run(params, ctx) {
    const called = calledConnections(ctx, hasCapability(ctx, params.capability));
    if (called.length === 0)
      return notApplicable(`No flow calls a ${params.capability} dependency.`);
    const open = called.filter((c) => !c.connection.policy.circuitBreaker);
    if (open.length === 0) {
      return passed(
        `A circuit breaker guards calls to ${called.map((c) => c.target.label).join(", ")}.`,
      );
    }
    return failed(
      `No circuit breaker on calls to ${open.map((c) => c.target.label).join(", ")}.`,
      connectionEvidence(open),
    );
  },
});

/** Retries do not keep an overloaded component overloaded, and the load model settles. */
export const stableUnderRetries = defineCheck({
  id: "stable-under-retries",
  description: "Retries do not keep a component overloaded (no retry storm).",
  params: z.strictObject({ environment: z.string().min(1) }),
  run(params, ctx) {
    const env = ctx.metrics.get(params.environment);
    if (!env) return notApplicable("This scenario does not simulate load.");
    const label = (id: string) =>
      ctx.attempt.architecture.components.find((c) => c.id === id)?.label ?? id;
    const storms = [...env.components.values()].filter((c) => {
      const load = c.readLoad + c.writeLoad;
      return c.utilization > 1 && load > 0 && c.retryLoad / load >= RETRY_STORM_SHARE;
    });
    const evidence: Evidence[] = storms.map((c) => ({
      type: "component",
      componentId: c.componentId,
    }));
    if (storms.length > 0) {
      const details = storms.map((c) => {
        const load = c.readLoad + c.writeLoad;
        const withoutRetries = (load - c.retryLoad) / load;
        const verdict =
          c.utilization * withoutRetries <= 1
            ? "retries alone push it over capacity"
            : "retries keep it overloaded";
        return `${label(c.componentId)}: ${Math.round((100 * c.retryLoad) / load)}% of its load is retries; ${verdict}`;
      });
      return failed(
        `Retries multiply the load on ${storms.map((c) => label(c.componentId)).join(", ")} while it is over capacity at ${env.environment.label}: a retry storm.`,
        evidence,
        details,
      );
    }
    if (!env.converged) {
      return failed(
        `The load model does not settle at ${env.environment.label}: failures, timeouts and retries keep feeding back.`,
        [],
      );
    }
    return passed(`No component is kept overloaded by retries at ${env.environment.label}.`);
  },
});
