import {
  ACTIONS,
  type Capability,
  callableFrom,
  connectionToCall,
  type LogicId,
  offeredLogic,
  type Step,
} from "@archdrill/model";
import { eventLabel } from "../../state/triggers";
import type { EditContext, GroupStep, Lead, Position } from "./flow-edits";
import type { PickerMode } from "./pick";
import { stepSentence } from "./sentences";
import { componentLabel } from "./step-label";
import { servesOnly } from "./step-options";

/** A usual way of doing something, added as one group of steps that can then be edited. */
export interface Pattern {
  readonly key: string;
  readonly name: string;
  /** What it does, as a sentence. */
  readonly label: string;
  readonly steps: readonly GroupStep[];
}

/** At most this many patterns of one kind, for the components most likely meant. */
const MAX_EACH = 2;

const OUT: Lead = { out: true };
const to = (step: string): Lead => ({ step });

type GroupStepInput = GroupStep["step"];

/** Lowercases a sentence's first letter, to carry on a sentence with it. */
const carryOn = (sentence: string) => sentence.charAt(0).toLowerCase() + sentence.slice(1);

/** Components the handler can call with a capability, those it is connected to first. */
function withCapability(ctx: EditContext, capability: Capability): string[] {
  const { attempt, catalog, flow } = ctx;
  return callableFrom(flow.handler, attempt, catalog)
    .filter((id) => {
      const c = attempt.architecture.components.find((x) => x.id === id);
      return c !== undefined && catalog.capabilities(c.kind, c.flavor).has(capability);
    })
    .sort(
      (a, b) =>
        Number(connectionToCall(flow.handler, a, attempt, catalog).kind === "add") -
        Number(connectionToCall(flow.handler, b, attempt, catalog).kind === "add"),
    );
}

/**
 * Read through a cache: look it up, and on a miss read the store and fill the
 * cache. Shared caches come before caches inside the service, and stores that
 * hold the entity before the others.
 */
function cacheAside(ctx: EditContext, entity: string): Pattern[] {
  if (ctx.background || ctx.operation.class !== "read") return [];
  const component = (id: string) => ctx.attempt.architecture.components.find((c) => c.id === id);
  const inProcess = (id: string) => ctx.catalog.kind(component(id)?.kind ?? "")?.inProcess === true;
  const caches = withCapability(ctx, "volatile-kv").sort(
    (a, b) => Number(inProcess(a)) - Number(inProcess(b)),
  );
  const durable = withCapability(ctx, "durable-store").filter((id) => !caches.includes(id));
  const holding = durable.filter((id) => component(id)?.data.some((d) => d.entity === entity));
  const stores = holding.length > 0 ? holding : durable;
  return caches
    .flatMap((cache) =>
      stores.map((store): Pattern => {
        const c = componentLabel(ctx.attempt, cache);
        return {
          key: `cache-aside:${cache}:${store}`,
          name: "Cache-aside",
          label: `Look up ${entity} in ${c}; on a miss, read it from ${componentLabel(ctx.attempt, store)} and save it in ${c}`,
          steps: [
            {
              key: "get",
              step: { type: "call", target: cache, action: "cache.get", entity },
              next: { hit: OUT, miss: to("read"), error: to("read") },
            },
            {
              key: "read",
              step: { type: "call", target: store, action: "store.read", entity },
              next: { found: to("save") },
            },
            {
              key: "save",
              step: { type: "call", target: cache, action: "cache.set", entity, ttlSec: 3600 },
              next: { ok: OUT, error: OUT },
            },
          ],
        };
      }),
    )
    .slice(0, MAX_EACH);
}

/** A way to get a new key: the first time, and again after a conflict. */
interface KeySource {
  readonly key: string;
  readonly first: GroupStepInput;
  readonly again: GroupStepInput;
}

/** Ways the design can make keys: an id generator it can call, or the problem's own logic. */
function keySources(ctx: EditContext): KeySource[] {
  const logic = (id: LogicId): GroupStepInput => ({ type: "logic", logic: id });
  const offered = offeredLogic(ctx.problem.logic);
  const allocate = (target: string): GroupStepInput => ({
    type: "call",
    target,
    action: "ids.allocate",
  });
  return [
    ...withCapability(ctx, "id-generation").map((id) => ({
      key: `ids:${id}`,
      first: allocate(id),
      again: allocate(id),
    })),
    ...(offered.includes("generateRandomCode")
      ? [{ key: "random", first: logic("generateRandomCode"), again: logic("generateRandomCode") }]
      : []),
    ...(offered.includes("hashUrl") && offered.includes("rehashWithSalt")
      ? [{ key: "hash", first: logic("hashUrl"), again: logic("rehashWithSalt") }]
      : []),
  ];
}

/** Whether a step already in the flow makes a key the way a source does. */
function makesKey(step: Step | undefined, input: GroupStepInput): boolean {
  if (step?.type === "logic" && input.type === "logic") return step.logic === input.logic;
  return (
    step?.type === "call" &&
    input.type === "call" &&
    step.action === input.action &&
    step.target === input.target
  );
}

/**
 * Insert with a new key, and on a conflict try once more with another one; a
 * second conflict answers 503. The first key comes from the step before when
 * that step makes one.
 */
function insertWithRetry(ctx: EditContext, entity: string, previous: Step | undefined): Pattern[] {
  if (ctx.background || ctx.operation.class !== "write") return [];
  // Right behind a conditional insert, the key is already taken care of.
  if (previous?.type === "call" && ACTIONS[previous.action].effect === "conditional-write")
    return [];
  const stores = withCapability(ctx, "conditional-write");
  const { attempt, background } = ctx;
  return stores
    .flatMap((store) =>
      keySources(ctx).map((source): Pattern => {
        const insert: GroupStepInput = {
          type: "call",
          target: store,
          action: "store.insertIfAbsent",
          entity,
        };
        const keyed = makesKey(previous, source.first);
        // Said once when the second key is made as the first was; named when it is made another way.
        const sameWay = JSON.stringify(source.first) === JSON.stringify(source.again);
        const tryAgain =
          !keyed && sameWay
            ? "on a conflict, try once more with a new one"
            : `on a conflict, ${carryOn(stepSentence(source.again, attempt, background))} and try once more`;
        const steps: GroupStep[] = [
          ...(keyed ? [] : [{ key: "key", step: source.first, next: { ok: to("insert") } }]),
          { key: "insert", step: insert, next: { ok: OUT, conflict: to("again") } },
          { key: "again", step: source.again, next: { ok: to("retry") } },
          { key: "retry", step: insert, next: { ok: OUT, conflict: { status: 503 } } },
        ];
        const write = stepSentence(insert, attempt, background);
        return {
          key: `retry:${store}:${source.key}`,
          name: "Insert with a retry",
          label: keyed
            ? `${write}; ${tryAgain}`
            : `${stepSentence(source.first, attempt, background)}, then ${carryOn(write)}; ${tryAgain}`,
          steps,
        };
      }),
    )
    .slice(0, MAX_EACH);
}

/** Words of an id, cut to their stem: "create-link" → ["crea", "link"]. */
const stems = (id: string) => id.split("-").map((word) => word.slice(0, 4));

/**
 * The events that name what the operation does: create-link publishes
 * link-created (both "crea…" and "link"), not link-clicked (only "link").
 */
function likeliestEvents<E extends { readonly id: string }>(
  events: readonly E[],
  operation: string,
): E[] {
  const words = new Set(stems(operation));
  const score = (event: E) => stems(event.id).filter((w) => words.has(w)).length;
  const best = Math.max(0, ...events.map(score));
  return events.filter((event) => score(event) === best);
}

/**
 * The queues that already carry an event, where a flow publishes it or its
 * consumers take it from; every queue when none does yet.
 */
function carrying(ctx: EditContext, queues: readonly string[], event: string): string[] {
  const { attempt, problem } = ctx;
  const consumers = new Set(
    problem.operations
      .filter((o) => o.trigger.type === "event" && o.trigger.event === event)
      .map((o) => o.id),
  );
  const carries = (queue: string) =>
    attempt.flows.some(
      (flow) =>
        Object.values(flow.steps).some(
          (s) =>
            s.type === "call" &&
            s.action === "queue.publish" &&
            s.target === queue &&
            s.event === event,
        ) ||
        (consumers.has(flow.operation) &&
          attempt.architecture.connections.some(
            (c) =>
              (c.from === queue && c.to === flow.handler) ||
              (c.from === flow.handler && c.to === queue),
          )),
    );
  const found = queues.filter(carries);
  return found.length > 0 ? found : [...queues];
}

/** Effects of a store write an outbox message can share a transaction with, as validation counts them. */
const WRITES: ReadonlySet<string> = new Set(["write", "conditional-write", "delete", "increment"]);

/**
 * Publish through a transactional outbox, offered right where a write to a
 * store with transactions has committed, as the outbox needs.
 */
function outboxPublish(ctx: EditContext, at: Position): Pattern[] {
  if (at.kind !== "after" || at.outcomes.some((o) => o !== "ok")) return [];
  const { attempt, catalog, problem } = ctx;
  const write = ctx.flow.steps[at.stepId];
  if (write?.type !== "call" || !WRITES.has(ACTIONS[write.action].effect)) return [];
  const store = attempt.architecture.components.find((c) => c.id === write.target);
  const caps = store ? catalog.capabilities(store.kind, store.flavor) : new Set<string>();
  if (!caps.has("durable-store") || !caps.has("transactions")) return [];
  const about = problem.events.filter((e) => e.entity === write.entity);
  const events = likeliestEvents(about.length > 0 ? about : problem.events, ctx.operation.id);
  const queues = withCapability(ctx, "async-buffer");
  return events
    .flatMap((event) =>
      carrying(ctx, queues, event.id).map(
        (queue): Pattern => ({
          key: `outbox:${queue}:${event.id}`,
          name: "Publish through an outbox",
          label: `Publish ${eventLabel(event.id)} to ${componentLabel(attempt, queue)} through an outbox, in the write's transaction`,
          steps: [
            {
              key: "publish",
              step: {
                type: "call",
                target: queue,
                action: "queue.publish",
                event: event.id,
                outbox: true,
              },
              next: { ok: OUT },
            },
          ],
        }),
      ),
    )
    .slice(0, MAX_EACH);
}

/** The patterns that fit a place of a flow, for the entity the operation works on. */
export function patternsAt(ctx: EditContext, mode: PickerMode, entity: string): Pattern[] {
  if (servesOnly(ctx)) return [];
  const previous = mode.at.kind === "after" ? ctx.flow.steps[mode.at.stepId] : undefined;
  return [
    ...cacheAside(ctx, entity),
    ...insertWithRetry(ctx, entity, previous),
    ...outboxPublish(ctx, mode.at),
  ];
}

/** The components a pattern calls, for connecting the handler to them. */
export function patternTargets(pattern: Pattern): string[] {
  return [
    ...new Set(pattern.steps.flatMap((s) => (s.step.type === "call" ? [s.step.target] : []))),
  ];
}
