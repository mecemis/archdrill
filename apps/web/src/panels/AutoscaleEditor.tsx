import { AUTOSCALE_WINDOW_SEC, DEFAULT_STARTUP_SEC } from "@archdrill/engine";
import type { Component } from "@archdrill/model";
import { MAX_REPLICAS } from "@archdrill/model";
import { useEffect, useState } from "react";
import { catalogIndex } from "../state/content";
import { useScenarioLoad } from "../state/evaluation";
import { useAttemptStore } from "../state/store";
import { percent } from "../ui/format";
import { Field, Select } from "../ui/primitives";

const TARGETS = [0.5, 0.6, 0.7, 0.8, 0.9];

const startupSec = (component: Component) =>
  catalogIndex.flavor(component.kind, component.flavor)?.startupSec ?? DEFAULT_STARTUP_SEC;
/** Default ceiling when autoscaling is switched on: room for a few times the minimum. */
const DEFAULT_HEADROOM = 4;

/** Autoscaling bounds for a service: the replicas are the minimum, `max` the ceiling. */
export function AutoscaleEditor({ component }: { readonly component: Component }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const { metrics } = useScenarioLoad();
  const autoscale = component.autoscale;
  const running = metrics?.components.get(component.id)?.instances;
  const set = (next: Component["autoscale"] | null) =>
    dispatch("setAutoscale", { id: component.id, autoscale: next ?? null });
  return (
    <fieldset className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm text-zinc-800">
        <input
          type="checkbox"
          checked={autoscale !== undefined}
          onChange={(e) =>
            set(
              e.target.checked
                ? {
                    max: Math.min(
                      MAX_REPLICAS,
                      Math.max(component.replicas + 1, component.replicas * DEFAULT_HEADROOM),
                    ),
                    targetUtilization: 0.7,
                  }
                : null,
            )
          }
        />
        Autoscale with load
      </label>
      {autoscale && (
        <div className="flex flex-wrap items-end gap-3 pl-6">
          <MaxInstances
            min={component.replicas}
            value={autoscale.max}
            onCommit={(max) => set({ ...autoscale, max })}
          />
          <Field label="Target utilisation">
            <Select
              value={autoscale.targetUtilization}
              onChange={(e) => set({ ...autoscale, targetUtilization: Number(e.target.value) })}
            >
              {TARGETS.map((t) => (
                <option key={t} value={t}>
                  {percent(t, 0)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {autoscale && running !== undefined && metrics && (
        <p className="pl-6 text-xs text-zinc-600">
          Runs {running} instance{running === 1 ? "" : "s"} at {metrics.environment.label}
          {running >= autoscale.max ? ", its maximum" : ""}.
        </p>
      )}
      {autoscale && (
        <p className="pl-6 text-xs text-zinc-500">
          It scales on the average utilisation of the last {AUTOSCALE_WINDOW_SEC} s, and a new
          instance takes {startupSec(component)} s to start taking traffic; timelines show the gap.
        </p>
      )}
    </fieldset>
  );
}

function MaxInstances({
  min,
  value,
  onCommit,
}: {
  readonly min: number;
  readonly value: number;
  readonly onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Math.round(Number(draft));
    const next = Number.isFinite(parsed) ? Math.min(MAX_REPLICAS, Math.max(min, parsed)) : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <Field label="Maximum instances">
      <input
        type="number"
        min={min}
        max={MAX_REPLICAS}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className="w-24 rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
      />
    </Field>
  );
}
