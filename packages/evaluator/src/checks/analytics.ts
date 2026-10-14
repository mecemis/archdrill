import type { CallPathStep, Path } from "@archdrill/engine";
import { ACTIONS, type ActionEffect } from "@archdrill/model";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { isSuccessPath, pathStatus } from "../predicates";
import {
  type CheckContext,
  defineCheck,
  failed,
  MAX_DETAIL_LINES,
  notApplicable,
  passed,
  requireOperation,
} from "./types";

/** Effects that change what a store holds (populating or invalidating a cache does not count). */
const STORE_WRITES: ReadonlySet<ActionEffect> = new Set([
  "write",
  "conditional-write",
  "delete",
  "increment",
]);

/** Share of credit kept when publishes wait for the queue. */
const WAITING_CREDIT = 0.5;
/** Share of credit kept when fire-and-forget publishes buffer without a bound. */
const UNBOUNDED_CREDIT = 0.75;

const calls = (path: Path) => path.steps.filter((s): s is CallPathStep => s.kind === "call");

/** Each call step once, however many paths pass it. */
function distinctSteps(paths: readonly Path[], keep: (s: CallPathStep) => boolean) {
  const steps = new Map<string, CallPathStep>();
  for (const path of paths) for (const s of calls(path)) if (keep(s)) steps.set(s.stepId, s);
  return [...steps.values()];
}

function label(ctx: CheckContext, componentId: string): string {
  return (
    ctx.attempt.architecture.components.find((c) => c.id === componentId)?.label ?? componentId
  );
}

function stepEvidence(operation: string, steps: readonly CallPathStep[]): Evidence[] {
  return steps.map((s) => ({ type: "step", operation, stepId: s.stepId }));
}

function stepDetails(ctx: CheckContext, steps: readonly CallPathStep[]): string[] {
  return steps
    .slice(0, MAX_DETAIL_LINES)
    .map(
      (s) =>
        `${label(ctx, s.target)} · ${ACTIONS[s.action].label}${s.entity ? ` ${s.entity}` : ""}`,
    );
}

/**
 * A read stays a read: its requests never wait for a write to a store. What
 * they need to record goes through a queue, so the busiest key of the read
 * path never becomes the busiest row of a store.
 */
export const noSyncWriteOnReadPath = defineCheck({
  id: "no-sync-write-on-read-path",
  description: "Requests of a read operation make no synchronous write to a store.",
  params: z.strictObject({ operation: z.string().min(1) }),
  run(params, ctx) {
    const op = requireOperation(ctx, params.operation);
    const writes = distinctSteps(op.paths, (s) => STORE_WRITES.has(ACTIONS[s.action].effect));
    const name = op.operation.label;
    if (writes.length === 0) return passed(`No ${name} request waits for a write to a store.`);
    const targets = [...new Set(writes.map((s) => label(ctx, s.target)))].join(" and ");
    return failed(
      `${name} requests write to ${targets} before answering. Every request becomes a write, a viral link's writes all land on one row, and the read path takes on the store's latency and failures.`,
      stepEvidence(params.operation, writes),
      stepDetails(ctx, writes),
    );
  },
});

/**
 * Every request that should be recorded publishes its event, and does so
 * without waiting: fire-and-forget into a local buffer with a bound, so a
 * slow or failed queue neither slows the request nor exhausts memory.
 */
export const publishesWithoutWaiting = defineCheck({
  id: "publishes-without-waiting",
  description:
    "Paths that answer with the given statuses publish the event fire-and-forget, through a bounded buffer.",
  params: z.strictObject({
    operation: z.string().min(1),
    event: z.string().min(1),
    statuses: z.array(z.number().int()).min(1),
  }),
  run(params, ctx) {
    const op = requireOperation(ctx, params.operation);
    const answering = op.paths.filter((p) => {
      const status = pathStatus(p);
      return status !== null && params.statuses.includes(status);
    });
    if (answering.length === 0) {
      return notApplicable(
        `No ${op.operation.label} path answers ${params.statuses.join(" or ")}.`,
      );
    }
    // A path that tried to publish counts, even where the queue did not take the message.
    const publishes = (s: CallPathStep) => s.action === "queue.publish" && s.event === params.event;
    const missing = answering.filter((p) => !calls(p).some(publishes));
    const event = ctx.problem.events.find((e) => e.id === params.event)?.label ?? params.event;
    if (missing.length === answering.length) {
      return failed(
        `No ${op.operation.label} path publishes ${event}, so nothing downstream ever sees it.`,
        missing.map((p) => ({ type: "path", operation: p.operation, pathId: p.id })),
      );
    }
    const steps = distinctSteps(answering, publishes);
    const waiting = steps.filter((s) => !s.fireAndForget);
    const unbounded = steps.filter((s) => s.fireAndForget && s.bufferSize === undefined);
    const problems: string[] = [];
    let fraction = 1 - missing.length / answering.length;
    if (missing.length > 0) {
      problems.push(`${missing.length} of ${answering.length} paths do not publish ${event}.`);
    }
    if (waiting.length > 0) {
      fraction *= WAITING_CREDIT;
      problems.push(
        "The publish waits for the queue: every request pays for the round trip, and a slow or failing queue slows or fails the request.",
      );
    }
    if (unbounded.length > 0) {
      fraction *= UNBOUNDED_CREDIT;
      problems.push(
        "The local buffer has no bound: while the queue is unreachable it grows until instances run out of memory.",
      );
    }
    if (problems.length === 0) {
      return passed(
        `Every ${op.operation.label} that answers ${params.statuses.join(" or ")} hands ${event} to a bounded local buffer and moves on.`,
      );
    }
    const evidence: Evidence[] = [
      ...stepEvidence(params.operation, [...waiting, ...unbounded]),
      ...missing.map((p): Evidence => ({ type: "path", operation: p.operation, pathId: p.id })),
    ];
    return {
      status: fraction > 0 ? "partial" : "fail",
      fraction,
      message: problems.join(" "),
      details: [],
      evidence,
    };
  },
});

/**
 * Queues deliver at least once, so a consumer sees some messages twice. A
 * write that adds (an increment) must then skip messages it has already
 * counted: record each message's id first, and count only when that record
 * is new. Writes that replace (a window's total) are idempotent as they are.
 */
export const idempotentConsumerWrites = defineCheck({
  id: "idempotent-consumer-writes",
  description:
    "A consumer's increments only happen after it recorded the message as new, so a redelivered message is not counted twice.",
  params: z.strictObject({ operation: z.string().min(1) }),
  run(params, ctx) {
    const op = requireOperation(ctx, params.operation);
    const name = op.operation.label;
    const keyOf = (entity: string | undefined) =>
      ctx.problem.entities.find((e) => e.name === entity)?.key;
    // Increments committed with a stream processor's checkpoints are not repeated by a replay.
    const counting = op.paths.filter(
      (p) =>
        isSuccessPath(p, op.operation) &&
        calls(p).some((s) => ACTIONS[s.action].effect === "increment" && !s.exactlyOnce),
    );
    if (counting.length === 0) {
      return passed(
        `${name} writes nothing that adds up: writing a message again writes the same.`,
      );
    }
    // A record of the message itself, keyed by something other than what is counted.
    const guarded = (path: Path) => {
      const steps = calls(path);
      const first = steps.findIndex((s) => ACTIONS[s.action].effect === "increment");
      const counted = steps[first];
      return steps
        .slice(0, first)
        .some(
          (s) =>
            s.action === "store.insertIfAbsent" &&
            s.outcome === "ok" &&
            keyOf(s.entity) !== keyOf(counted?.entity),
        );
    };
    const unguarded = counting.filter((p) => !guarded(p));
    if (unguarded.length === 0)
      return passed(`${name} records each message as new before counting it.`);
    const increments = distinctSteps(unguarded, (s) => ACTIONS[s.action].effect === "increment");
    return failed(
      `${name} adds again for every redelivered message, so counts drift upwards whenever a consumer restarts or a write times out.`,
      stepEvidence(params.operation, increments),
      stepDetails(ctx, increments),
    );
  },
});

/**
 * Published messages are only worth something if a consumer handles them:
 * the operation publishes the event, and a consumer of it is ready to run.
 */
export const eventConsumed = defineCheck({
  id: "event-consumed",
  description:
    "The operation publishes the event, and a consumer receives and handles its messages.",
  params: z.strictObject({ operation: z.string().min(1), event: z.string().min(1) }),
  run(params, ctx) {
    const op = requireOperation(ctx, params.operation);
    const event = ctx.problem.events.find((e) => e.id === params.event)?.label ?? params.event;
    const analyses = [...ctx.analysis.operations.values()];
    const publishing = distinctSteps(
      op.paths,
      (s) => s.action === "queue.publish" && s.event === params.event,
    );
    if (publishing.length === 0) {
      const succeeding = op.paths.filter((p) => isSuccessPath(p, op.operation));
      return failed(
        `No ${op.operation.label} path publishes ${event}, so nothing is ever counted.`,
        succeeding.map((p): Evidence => ({ type: "path", operation: p.operation, pathId: p.id })),
      );
    }
    const consumers = analyses.filter((op) => {
      const trigger = op.operation.trigger;
      return (
        trigger.type === "event" &&
        trigger.event === params.event &&
        op.status === "ready" &&
        op.ingress !== null
      );
    });
    if (consumers.length === 0) {
      return failed(
        `${event} is published, but no consumer receives it: the messages pile up and nothing is counted.`,
        [
          ...stepEvidence(params.operation, publishing),
          ...publishing.map((s): Evidence => ({ type: "component", componentId: s.target })),
        ],
      );
    }
    return passed(`${consumers.map((c) => c.operation.label).join(" and ")} handles ${event}.`);
  },
});

/**
 * Expired data does not stay forever: a job deletes it, or the store expires
 * it by itself because every write of it carries a TTL.
 */
export const expiredDataRemoved = defineCheck({
  id: "expired-data-removed",
  description:
    "A job deletes the entity once it expires, or every write of it carries a TTL that the store enforces.",
  params: z.strictObject({ entity: z.string().min(1), job: z.string().min(1) }),
  run(params, ctx) {
    const job = ctx.analysis.operations.get(params.job);
    const deletes = (job?.paths ?? []).some((p) =>
      calls(p).some(
        (s) => s.action === "store.delete" && s.entity === params.entity && s.outcome === "ok",
      ),
    );
    if (deletes) return passed(`${job?.operation.label} deletes expired ${params.entity} records.`);
    const writes = [...ctx.analysis.operations.values()].flatMap((op) =>
      distinctSteps(
        op.paths,
        (s) =>
          s.entity === params.entity &&
          (s.action === "store.insert" || s.action === "store.insertIfAbsent"),
      ).map((step) => ({ operation: op.operation.id, step })),
    );
    if (writes.length > 0 && writes.every(({ step }) => step.ttlSec !== undefined)) {
      return passed(
        `The store expires ${params.entity} records by itself: every write sets a TTL.`,
      );
    }
    const evidence: Evidence[] = writes
      .filter(({ step }) => step.ttlSec === undefined)
      .map(({ operation, step }) => ({ type: "step", operation, stepId: step.stepId }));
    return failed(
      `Nothing removes expired ${params.entity} records: no job deletes them, and the writes set no TTL.`,
      evidence,
    );
  },
});
