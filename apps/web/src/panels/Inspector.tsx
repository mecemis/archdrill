import { componentProfile, HOURS_PER_MONTH } from "@archdrill/engine";
import { type Component, placedInZones, runsInRegion } from "@archdrill/model";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { activePack, catalogIndex } from "../state/content";
import { useAttemptStore } from "../state/store";
import { useUi } from "../state/ui-store";
import { compact, usd } from "../ui/format";
import { Button, Field, INPUT_CLASS, SectionTitle, Select } from "../ui/primitives";
import { AutoscaleEditor } from "./AutoscaleEditor";
import { ConnectionInspector } from "./ConnectionInspector";
import { ProvenancePanel } from "./ProvenancePanel";
import { RegionPicker } from "./RegionPicker";
import { ZonePicker } from "./ZonePicker";

const MAX_REPLICAS = 200;
const MAX_SHARDS = 64;

export function Inspector() {
  const selection = useUi((s) => s.selection);
  const attempt = useAttemptStore((s) => s.attempt);
  if (!selection) {
    return (
      <p className="p-4 text-sm text-fg-subtle">Select a component or a connection to edit it.</p>
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
    shards?: number;
    zones?: number;
    regions?: number;
  }) => dispatch("updateComponent", { id: component.id, ...changes });
  const profile = componentProfile(component, catalogIndex);

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
      {kind?.shardable && (
        <CountSlider
          label="Shards"
          max={MAX_SHARDS}
          value={component.shards}
          onCommit={(shards) => update({ shards })}
        />
      )}
      {kind?.replicable && !flavor?.managedRedundancy && (
        <CountSlider
          label={component.autoscale ? "Replicas (minimum)" : "Replicas"}
          max={MAX_REPLICAS}
          value={component.replicas}
          onCommit={(replicas) => update({ replicas })}
        />
      )}
      {kind && flavor && placedInZones(kind, flavor) && (
        <ZonePicker component={component} onChange={(zones) => update({ zones })} />
      )}
      {kind && flavor && runsInRegion(kind, flavor) && (
        <RegionPicker component={component} onChange={(regions) => update({ regions })} />
      )}
      {kind?.replicable && !kind.holdsData && !flavor?.managedRedundancy && (
        <AutoscaleEditor component={component} />
      )}
      {kind?.inProcess && <InProcessNote component={component} />}
      {size && profile && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-fg-muted">
          <dt>Reads</dt>
          <dd className="tabular-nums">{compact(profile.readCapacity)}/s</dd>
          <dt>Writes</dt>
          <dd className="tabular-nums">{compact(profile.writeCapacity)}/s</dd>
          {profile.memoryGb > 0 && (
            <>
              <dt>Memory</dt>
              <dd className="tabular-nums">{compact(profile.memoryGb)} GB</dd>
            </>
          )}
          <dt>Base latency</dt>
          <dd className="tabular-nums">{size.latencyMs.base} ms</dd>
          <dt>Instances</dt>
          <dd className="tabular-nums">
            {profile.instances} · {usd(profile.costPerHour * HOURS_PER_MONTH)} / month
          </dd>
        </dl>
      )}
      {flavor?.managedRedundancy && (
        <p className="rounded-md bg-sunken px-2.5 py-2 text-xs text-fg-muted">
          Managed and redundant across zones; no replicas to configure.
        </p>
      )}
      {kind?.holdsData && <DataBindings component={component} />}
      <div className="flex flex-wrap gap-1">
        {capabilities.map((cap) => (
          <span key={cap} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-fg-muted">
            {cap}
          </span>
        ))}
      </div>
      {flavor?.notes && <p className="text-xs text-fg-subtle">{flavor.notes}</p>}
      <ProvenancePanel kind={component.kind} flavor={component.flavor} sizeId={component.size} />
      <RemoveComponentButton component={component} />
    </div>
  );
}

/** Where an in-process component lives, since that decides how many copies there are. */
function InProcessNote({ component }: { readonly component: Component }) {
  const host = useAttemptStore((s) => {
    const caller = s.attempt.architecture.connections.find((c) => c.to === component.id)?.from;
    return s.attempt.architecture.components.find((c) => c.id === caller)?.label;
  });
  return (
    <p className="rounded-md bg-sunken px-2.5 py-2 text-xs text-fg-muted">
      {host
        ? `Runs inside ${host}: no network hop, and one copy per instance of it.`
        : "Connect the service it should run inside."}
    </p>
  );
}

/** Edits locally while dragging and commits once on release, so a drag is one undo step. */
function CountSlider({
  label,
  max,
  value,
  onCommit,
}: {
  readonly label: string;
  readonly max: number;
  readonly value: number;
  readonly onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <Field label={`${label} (${draft})`}>
      <input
        type="range"
        min={1}
        max={max}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label={label}
      />
    </Field>
  );
}

/** Removing a service also removes the flows it handles, so that case asks first. */
function RemoveComponentButton({ component }: { readonly component: Component }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const handled = useAttemptStore(
    (s) => s.attempt.flows.filter((f) => f.handler === component.id).length,
  );
  const [confirming, setConfirming] = useState(false);
  const remove = () => {
    dispatch("removeComponent", { id: component.id });
    useUi.getState().select(null);
  };
  if (confirming) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-bad-line bg-bad-soft p-2.5 text-sm">
        <p className="text-bad-fg">
          {component.label} handles {handled} flow{handled === 1 ? "" : "s"}. Removing it removes{" "}
          {handled === 1 ? "that flow" : "those flows"} too.
        </p>
        <div className="flex gap-2">
          <Button variant="danger" onClick={remove}>
            Remove both
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <Button
      variant="danger"
      className="self-start"
      onClick={() => (handled > 0 ? setConfirming(true) : remove())}
    >
      <Trash2 className="h-4 w-4" />
      Remove component
    </Button>
  );
}

function DataBindings({ component }: { readonly component: Component }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const stored = new Set(component.data.map((d) => d.entity));
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium text-fg-muted">Stores</legend>
      {activePack.problem.entities.map((entity) => (
        <label key={entity.name} className="flex items-center gap-2 text-sm text-fg">
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
          <span className="text-xs text-fg-subtle">key: {entity.key}</span>
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
        className={INPUT_CLASS}
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
