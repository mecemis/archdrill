import type { ConnectionCallMetrics } from "@archdrill/engine";
import {
  type Connection,
  type ConnectionPolicy,
  MAX_RETRIES,
  MAX_TIMEOUT_MS,
} from "@archdrill/model";
import { ArrowLeftRight, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { catalogIndex } from "../state/content";
import { useScenarioLoad } from "../state/evaluation";
import { useAttemptStore } from "../state/store";
import { useUi } from "../state/ui-store";
import { compact, percent } from "../ui/format";
import { Button, Field, SectionTitle, Select } from "../ui/primitives";

const RETRY_OPTIONS = Array.from({ length: MAX_RETRIES + 1 }, (_, n) => n);

export function ConnectionInspector({ connection }: { readonly connection: Connection }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const components = useAttemptStore((s) => s.attempt.architecture.components);
  const label = (id: string) => components.find((c) => c.id === id)?.label ?? id;
  const source = components.find((c) => c.id === connection.from);
  const callsFlowSteps =
    source !== undefined &&
    catalogIndex.capabilities(source.kind, source.flavor).has("stateless-compute");
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
      {callsFlowSteps ? (
        <PolicyEditor connection={connection} />
      ) : (
        <p className="text-xs text-zinc-500">
          Requests pass this hop on their way in. Timeouts, retries and circuit breakers apply to
          the calls a service makes from its flow steps.
        </p>
      )}
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

function PolicyEditor({ connection }: { readonly connection: Connection }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const policy: ConnectionPolicy = connection.policy;
  const set = (change: Omit<Parameters<typeof dispatch<"setConnectionPolicy">>[1], "id">) =>
    dispatch("setConnectionPolicy", { id: connection.id, ...change });
  const retrying = policy.retries > 0;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1">
        <SectionTitle>Call policy</SectionTitle>
      </legend>
      <OptionalNumber
        label="Timeout"
        unit="ms"
        max={MAX_TIMEOUT_MS}
        value={policy.timeoutMs}
        placeholder={50}
        offHint="No timeout: a hung call waits for the client default (30 s)."
        onCommit={(timeoutMs) => set({ timeoutMs })}
      />
      <Field label="Retries after a failed attempt">
        <Select value={policy.retries} onChange={(e) => set({ retries: Number(e.target.value) })}>
          {RETRY_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "No retries" : `${n} ${n === 1 ? "retry" : "retries"}`}
            </option>
          ))}
        </Select>
      </Field>
      {retrying && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Field label="Backoff">
            <Select
              value={policy.backoff}
              onChange={(e) => set({ backoff: e.target.value as ConnectionPolicy["backoff"] })}
            >
              <option value="exponential">Exponential (10 ms, doubling)</option>
              <option value="none">None (retry at once)</option>
            </Select>
          </Field>
          <Checkbox
            label="Jitter"
            checked={policy.jitter}
            disabled={policy.backoff === "none"}
            onChange={(jitter) => set({ jitter })}
          />
        </div>
      )}
      <Checkbox
        label="Circuit breaker (stop calling while most calls fail)"
        checked={policy.circuitBreaker}
        onChange={(circuitBreaker) => set({ circuitBreaker })}
      />
      <OptionalNumber
        label="Bulkhead"
        unit="calls/s"
        max={1e9}
        value={policy.maxRps}
        placeholder={10_000}
        offHint="No bulkhead: every call reaches the dependency."
        onCommit={(maxRps) => set({ maxRps })}
      />
      <CallMetrics connectionId={connection.id} />
    </fieldset>
  );
}

function Checkbox({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-zinc-800">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/** A value that can be switched off; edits commit on blur or Enter, so typing is one undo step. */
function OptionalNumber({
  label,
  unit,
  max,
  value,
  placeholder,
  offHint,
  onCommit,
}: {
  readonly label: string;
  readonly unit: string;
  readonly max: number;
  readonly value: number | undefined;
  readonly placeholder: number;
  readonly offHint: string;
  readonly onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    const parsed = Math.round(Number(draft));
    if (!Number.isFinite(parsed) || parsed < 1) {
      setDraft(value === undefined ? "" : String(value));
      return;
    }
    const next = Math.min(max, parsed);
    // Show what was stored, also when clamping or rounding left the value unchanged.
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  const enabled = value !== undefined;
  return (
    <div className="flex flex-col gap-1">
      <Checkbox
        label={label}
        checked={enabled}
        onChange={(on) => onCommit(on ? placeholder : null)}
      />
      {enabled ? (
        <label className="flex items-center gap-2 pl-6 text-xs text-zinc-600">
          <input
            type="number"
            min={1}
            max={max}
            value={draft}
            aria-label={`${label} (${unit})`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
            className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-sm"
          />
          {unit}
        </label>
      ) : (
        <p className="pl-6 text-xs text-zinc-500">{offHint}</p>
      )}
    </div>
  );
}

/** What the flow steps' calls over this connection experience in the selected environment. */
function CallMetrics({ connectionId }: { readonly connectionId: string }) {
  const { metrics } = useScenarioLoad();
  const calls: ConnectionCallMetrics | undefined = metrics?.calls.get(connectionId);
  if (!metrics || !calls || calls.calls <= 0) return null;
  const rows: [string, string][] = [
    ["Calls", `${compact(calls.calls)}/s`],
    ["Attempts (with retries)", `${compact(calls.attempts)}/s`],
    ["Calls that fail", percent(calls.failure, 2)],
  ];
  if (calls.timedOut > 0.0001) rows.push(["Attempts timed out", percent(calls.timedOut, 1)]);
  if (calls.shortCircuit > 0.0001)
    rows.push(["Failed fast by the breaker", percent(calls.shortCircuit, 1)]);
  if (calls.shed > 0.0001) rows.push(["Rejected by the bulkhead", percent(calls.shed, 1)]);
  return (
    <section className="rounded-md bg-zinc-50 p-2.5 text-xs">
      <h4 className="mb-1 font-semibold text-zinc-600">At {metrics.environment.label}</h4>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-zinc-600">{term}</dt>
            <dd className="text-right text-zinc-900">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
