import type { Draft } from "immer";
import { z } from "zod";
import { type Attempt, PositionSchema } from "../attempt/schema";
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
    replicas: z.number().int().min(1).optional(),
  }),
  (draft, args) => {
    const component = draft.architecture.components[requireComponentIndex(draft, args.id)];
    if (!component) return;
    if (args.label !== undefined) component.label = args.label;
    if (args.flavor !== undefined) component.flavor = args.flavor;
    if (args.size === null) delete component.size;
    else if (args.size !== undefined) component.size = args.size;
    if (args.replicas !== undefined) component.replicas = args.replicas;
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

export const setDecision = defineCommand(
  z.object({ decision: IdSchema, option: IdSchema.nullable() }),
  (draft, { decision, option }) => {
    if (option === null) delete draft.decisions[decision];
    else draft.decisions[decision] = option;
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
