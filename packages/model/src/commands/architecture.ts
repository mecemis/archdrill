import type { Draft } from "immer";
import { z } from "zod";
import {
  type Attempt,
  DEFAULT_POLICY,
  MAX_POOL_SIZE,
  MAX_REGIONS,
  MAX_REPLICAS,
  MAX_RETRIES,
  MAX_SHARDS,
  MAX_TIMEOUT_MS,
  MAX_ZONES,
  PositionSchema,
} from "../attempt/schema";
import { IdSchema } from "../catalog/schema";
import { CommandError, defineCommand, nextNumberedId, requireComponentIndex } from "./define";
import { detachSteps } from "./flows";

export const addComponent = defineCommand(
  z.object({
    id: IdSchema.optional(),
    kind: IdSchema,
    flavor: IdSchema,
    label: z.string().min(1),
    size: IdSchema.optional(),
    replicas: z.number().int().min(1).optional(),
    position: PositionSchema,
  }),
  (draft, args) => {
    const existing = draft.architecture.components.map((c) => c.id);
    const id = args.id ?? nextNumberedId(args.kind, existing);
    if (existing.includes(id)) throw new CommandError(`Component "${id}" already exists.`);
    draft.architecture.components.push({
      id,
      kind: args.kind,
      flavor: args.flavor,
      label: args.label,
      ...(args.size === undefined ? {} : { size: args.size }),
      replicas: args.replicas ?? 1,
      shards: 1,
      zones: 1,
      regions: 1,
      proxy: false,
      data: [],
    });
    draft.layout[id] = { ...args.position };
    return id;
  },
);

export const removeComponent = defineCommand(z.object({ id: IdSchema }), (draft, { id }) => {
  const index = requireComponentIndex(draft, id);
  draft.architecture.components.splice(index, 1);
  delete draft.layout[id];
  draft.architecture.connections = draft.architecture.connections.filter(
    (c) => c.from !== id && c.to !== id,
  );
  draft.flows = draft.flows.filter((f) => f.handler !== id);
  for (const flow of draft.flows) {
    const calling = Object.entries(flow.steps)
      .filter(([, step]) => step.type === "call" && step.target === id)
      .map(([stepId]) => stepId);
    detachSteps(flow, calling);
  }
});

export const updateComponent = defineCommand(
  z.object({
    id: IdSchema,
    label: z.string().min(1).optional(),
    flavor: IdSchema.optional(),
    size: IdSchema.nullable().optional(),
    replicas: z.number().int().min(1).max(MAX_REPLICAS).optional(),
    shards: z.number().int().min(1).max(MAX_SHARDS).optional(),
    zones: z.number().int().min(1).max(MAX_ZONES).optional(),
    regions: z.number().int().min(1).max(MAX_REGIONS).optional(),
    proxy: z.boolean().optional(),
  }),
  (draft, args) => {
    const component = draft.architecture.components[requireComponentIndex(draft, args.id)];
    if (!component) return;
    if (args.label !== undefined) component.label = args.label;
    if (args.flavor !== undefined) component.flavor = args.flavor;
    if (args.size === null) delete component.size;
    else if (args.size !== undefined) component.size = args.size;
    if (args.replicas !== undefined) component.replicas = args.replicas;
    if (args.shards !== undefined) component.shards = args.shards;
    if (args.zones !== undefined) component.zones = args.zones;
    if (args.regions !== undefined) component.regions = args.regions;
    if (args.proxy !== undefined) component.proxy = args.proxy;
    // Instances cannot be spread over more zones than there are of them.
    component.zones = Math.max(1, Math.min(component.zones, component.replicas * component.shards));
  },
);

export const setAutoscale = defineCommand(
  z.object({
    id: IdSchema,
    autoscale: z
      .object({
        max: z.number().int().min(1).max(MAX_REPLICAS),
        targetUtilization: z.number().min(0.2).max(0.95).default(0.7),
      })
      .nullable(),
  }),
  (draft, { id, autoscale }) => {
    const component = draft.architecture.components[requireComponentIndex(draft, id)];
    if (!component) return;
    if (autoscale === null) delete component.autoscale;
    else component.autoscale = autoscale;
  },
);

export const setComponentData = defineCommand(
  z.object({ id: IdSchema, entities: z.array(z.string().min(1)) }),
  (draft, { id, entities }) => {
    const component = draft.architecture.components[requireComponentIndex(draft, id)];
    if (!component) return;
    component.data = [...new Set(entities)].map((entity) => ({ entity }));
  },
);

export const moveComponent = defineCommand(
  z.object({ id: IdSchema, position: PositionSchema }),
  (draft, { id, position }) => {
    requireComponentIndex(draft, id);
    draft.layout[id] = { ...position };
  },
);

export const addConnection = defineCommand(
  z.object({
    id: IdSchema.optional(),
    from: IdSchema,
    to: IdSchema,
    mode: z.enum(["sync", "async"]).optional(),
  }),
  (draft, args) => {
    requireComponentIndex(draft, args.from);
    requireComponentIndex(draft, args.to);
    if (args.from === args.to) throw new CommandError("A component cannot connect to itself.");
    assertPairFree(draft, args.from, args.to);
    const id = args.id ?? connectionId(args.from, args.to);
    if (draft.architecture.connections.some((c) => c.id === id)) {
      throw new CommandError(`Connection "${id}" already exists.`);
    }
    draft.architecture.connections.push({
      id,
      from: args.from,
      to: args.to,
      mode: args.mode ?? "sync",
      policy: { ...DEFAULT_POLICY },
    });
    return id;
  },
);

export const removeConnection = defineCommand(z.object({ id: IdSchema }), (draft, { id }) => {
  const index = requireConnectionIndex(draft, id);
  draft.architecture.connections.splice(index, 1);
});

export const reverseConnection = defineCommand(z.object({ id: IdSchema }), (draft, { id }) => {
  const connection = draft.architecture.connections[requireConnectionIndex(draft, id)];
  if (!connection) return;
  assertPairFree(draft, connection.to, connection.from);
  const { from, to } = connection;
  const newId = connectionId(to, from);
  if (draft.architecture.connections.some((c) => c.id === newId)) {
    throw new CommandError(`Connection "${newId}" already exists.`);
  }
  connection.from = to;
  connection.to = from;
  connection.id = newId;
});

export const setConnectionMode = defineCommand(
  z.object({ id: IdSchema, mode: z.enum(["sync", "async"]) }),
  (draft, { id, mode }) => {
    const connection = draft.architecture.connections[requireConnectionIndex(draft, id)];
    if (connection) connection.mode = mode;
  },
);

export const setConnectionPolicy = defineCommand(
  z.object({
    id: IdSchema,
    timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).nullable().optional(),
    retries: z.number().int().min(0).max(MAX_RETRIES).optional(),
    backoff: z.enum(["none", "exponential"]).optional(),
    jitter: z.boolean().optional(),
    circuitBreaker: z.boolean().optional(),
    maxRps: z.number().positive().max(1e9).nullable().optional(),
    sameZone: z.boolean().optional(),
    poolSize: z.number().int().min(1).max(MAX_POOL_SIZE).nullable().optional(),
  }),
  (draft, args) => {
    const policy = draft.architecture.connections[requireConnectionIndex(draft, args.id)]?.policy;
    if (!policy) return;
    if (args.timeoutMs === null) delete policy.timeoutMs;
    else if (args.timeoutMs !== undefined) policy.timeoutMs = args.timeoutMs;
    if (args.maxRps === null) delete policy.maxRps;
    else if (args.maxRps !== undefined) policy.maxRps = args.maxRps;
    if (args.retries !== undefined) policy.retries = args.retries;
    if (args.backoff !== undefined) policy.backoff = args.backoff;
    if (args.jitter !== undefined) policy.jitter = args.jitter;
    if (args.circuitBreaker !== undefined) policy.circuitBreaker = args.circuitBreaker;
    if (args.sameZone !== undefined) policy.sameZone = args.sameZone;
    if (args.poolSize === null) delete policy.poolSize;
    else if (args.poolSize !== undefined) policy.poolSize = args.poolSize;
  },
);

export const setDecision = defineCommand(
  z.object({ decision: IdSchema, option: IdSchema.nullable() }),
  (draft, { decision, option }) => {
    if (option === null) delete draft.decisions[decision];
    else draft.decisions[decision] = option;
  },
);

/** Records (or with null, clears) the candidate's answer to an estimate. */
export const setEstimate = defineCommand(
  z.object({ estimate: IdSchema, value: z.number().positive().nullable() }),
  (draft, { estimate, value }) => {
    if (value === null) delete draft.estimates[estimate];
    else draft.estimates[estimate] = value;
  },
);

function connectionId(from: string, to: string): string {
  return `${from}--${to}`;
}

function requireConnectionIndex(draft: Draft<Attempt>, id: string): number {
  const index = draft.architecture.connections.findIndex((c) => c.id === id);
  if (index < 0) throw new CommandError(`Connection "${id}" does not exist.`);
  return index;
}

function assertPairFree(draft: Draft<Attempt>, from: string, to: string): void {
  if (draft.architecture.connections.some((c) => c.from === from && c.to === to)) {
    throw new CommandError(`"${from}" is already connected to "${to}".`);
  }
}
