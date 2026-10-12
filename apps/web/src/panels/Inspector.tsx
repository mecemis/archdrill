import type { Component, Connection } from "@archdrill/model";
import { ArrowLeftRight, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { activePack, catalogIndex } from "../state/content";
import { useAttemptStore } from "../state/store";
import { useUi } from "../state/ui-store";
import { Button, Field, SectionTitle, Select } from "../ui/primitives";

const MAX_REPLICAS = 50;

export function Inspector() {
  const selection = useUi((s) => s.selection);
  const attempt = useAttemptStore((s) => s.attempt);
  if (!selection) {
    return (
      <p className="p-4 text-sm text-zinc-500">Select a component or a connection to edit it.</p>
    );
  }
  if (selection.type === "component") {
    const component = attempt.architecture.components.find((c) => c.id === selection.id);
    return component ? <ComponentInspector component={component} /> : null;
  }
  const connection = attempt.architecture.connections.find((c) => c.id === selection.id);
  return connection ? <ConnectionInspector connection={connection} /> : null;
}

function ComponentInspector({ component }: { readonly component: Component }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const kind = catalogIndex.kind(component.kind);
  const flavor = catalogIndex.flavor(component.kind, component.flavor);
  const size = component.size ? flavor?.sizes[component.size] : undefined;
  const capabilities = [...catalogIndex.capabilities(component.kind, component.flavor)];
  const update = (changes: {
    label?: string;
    flavor?: string;
    size?: string | null;
    replicas?: number;
  }) => dispatch("updateComponent", { id: component.id, ...changes });

  return (
    <div className="flex flex-col gap-4 p-4">
      <SectionTitle>{kind?.label ?? component.kind}</SectionTitle>
      <LabelInput value={component.label} onCommit={(label) => update({ label })} />
      {kind && kind.flavors.length > 1 && (
        <Field label="Technology">
          <Select
            value={component.flavor}
            onChange={(e) => {
              const next = catalogIndex.flavor(component.kind, e.target.value);
              update({ flavor: e.target.value, size: next?.defaultSize ?? null });
            }}
          >
            {kind.flavors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {flavor && Object.keys(flavor.sizes).length > 0 && (
        <Field label="Size">
          <Select value={component.size ?? ""} onChange={(e) => update({ size: e.target.value })}>
            {Object.entries(flavor.sizes).map(([id, s]) => (
              <option key={id} value={id}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {size && (
        <p className="text-xs text-zinc-500">
          ~{size.capacityPerSec.read?.toLocaleString() ?? "?"} reads/s per instance ·{" "}
          {size.latencyMs.base} ms base latency
        </p>
      )}
      {kind?.replicable && !flavor?.managedRedundancy && (
        <Field label={`Replicas (${component.replicas})`}>
          <input
            type="range"
            min={1}
            max={MAX_REPLICAS}
            value={component.replicas}
            onChange={(e) => update({ replicas: Number(e.target.value) })}
            aria-label="Replicas"
          />
        </Field>
      )}
      {flavor?.managedRedundancy && (
        <p className="rounded-md bg-zinc-50 px-2.5 py-2 text-xs text-zinc-600">
          Managed and redundant across zones; no replicas to configure.
        </p>
      )}
      {kind?.holdsData && <DataBindings component={component} />}
      <div className="flex flex-wrap gap-1">
        {capabilities.map((cap) => (
          <span key={cap} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-700">
            {cap}
          </span>
        ))}
      </div>
      {flavor?.notes && <p className="text-xs text-zinc-500">{flavor.notes}</p>}
      <Button
        variant="danger"
        className="self-start"
        onClick={() => {
          dispatch("removeComponent", { id: component.id });
          useUi.getState().select(null);
        }}
      >
        <Trash2 className="h-4 w-4" />
        Remove component
      </Button>
    </div>
  );
}

function DataBindings({ component }: { readonly component: Component }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const stored = new Set(component.data.map((d) => d.entity));
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium text-zinc-600">Stores</legend>
      {activePack.problem.entities.map((entity) => (
        <label key={entity.name} className="flex items-center gap-2 text-sm text-zinc-800">
          <input
            type="checkbox"
            checked={stored.has(entity.name)}
            onChange={(e) => {
              const next = new Set(stored);
              if (e.target.checked) next.add(entity.name);
              else next.delete(entity.name);
              dispatch("setComponentData", { id: component.id, entities: [...next] });
            }}
          />
          {entity.name}
          <span className="text-xs text-zinc-500">key: {entity.key}</span>
        </label>
      ))}
    </fieldset>
  );
}

function LabelInput({
  value,
  onCommit,
}: {
  readonly value: string;
  readonly onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onCommit(trimmed);
    else setDraft(value);
  };
  return (
    <Field label="Name">
      <input
        className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </Field>
  );
}

function ConnectionInspector({ connection }: { readonly connection: Connection }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const components = useAttemptStore((s) => s.attempt.architecture.components);
  const label = (id: string) => components.find((c) => c.id === id)?.label ?? id;
  return (
    <div className="flex flex-col gap-4 p-4">
      <SectionTitle>Connection</SectionTitle>
      <p className="text-sm text-zinc-900">
        {label(connection.from)} → {label(connection.to)}
      </p>
      <Field label="Mode">
        <Select
          value={connection.mode}
          onChange={(e) =>
            dispatch("setConnectionMode", {
              id: connection.id,
              mode: e.target.value as "sync" | "async",
            })
          }
        >
          <option value="sync">Synchronous (request/response)</option>
          <option value="async">Asynchronous (fire and forget)</option>
        </Select>
      </Field>
      <div className="flex gap-2">
        <Button
          onClick={() => {
            dispatch("reverseConnection", { id: connection.id });
            useUi.getState().select(null);
          }}
        >
          <ArrowLeftRight className="h-4 w-4" />
          Reverse
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            dispatch("removeConnection", { id: connection.id });
            useUi.getState().select(null);
          }}
        >
          <Trash2 className="h-4 w-4" />
          Remove
        </Button>
      </div>
    </div>
  );
}
