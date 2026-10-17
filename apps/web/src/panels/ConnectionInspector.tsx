import {
  type ConnectionCallMetrics,
  type ConnectionZoneMetrics,
  DEFAULT_POOL_SIZE,
  type PoolMetrics,
  zoneRoutes,
} from "@archdrill/engine";
import {
  type Connection,
  type ConnectionPolicy,
  canHandle,
  MAX_POOL_SIZE,
  MAX_RETRIES,
  MAX_TIMEOUT_MS,
} from "@archdrill/model";
import { ArrowLeftRight, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { catalogIndex } from "../state/content";
import { useScenarioLoad } from "../state/evaluation";
import { useAttemptStore } from "../state/store";
import { useUi } from "../state/ui-store";
import { compact, milliseconds, percent, usd } from "../ui/format";
import { Button, Field, INPUT_CLASS, SectionTitle, Select } from "../ui/primitives";

const RETRY_OPTIONS = Array.from({ length: MAX_RETRIES + 1 }, (_, n) => n);

export function ConnectionInspector({ connection }: { readonly connection: Connection }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const components = useAttemptStore((s) => s.attempt.architecture.components);
  const label = (id: string) => components.find((c) => c.id === id)?.label ?? id;
  const source = components.find((c) => c.id === connection.from);
  // Services and stream processors call over connections from flow steps.
  const callsFlowSteps =
    source !== undefined && canHandle(catalogIndex.capabilities(source.kind, source.flavor), true);
  const target = components.find((c) => c.id === connection.to);
  // Stores that run one statement per connection are reached through a pool on each caller instance.
  const pooled =
    callsFlowSteps && target !== undefined && catalogIndex.kind(target.kind)?.pooledConnections;
  return (
    <div className="flex flex-col gap-4 p-4">
      <SectionTitle>Connection</SectionTitle>
      <p className="text-sm text-fg">
        {label(connection.from)} → {label(connection.to)}
      </p>
      {callsFlowSteps ? (
        <PolicyEditor connection={connection} />
      ) : (
        <p className="text-xs text-fg-subtle">
          Requests pass this hop on their way in. Timeouts, retries and circuit breakers apply to
          the calls a service makes from its flow steps.
        </p>
      )}
      {pooled && <ConnectionPool connection={connection} />}
      <ZoneRouting connection={connection} />
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
    <label className="flex items-center gap-2 text-sm text-fg">
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
        <label className="flex items-center gap-2 pl-6 text-xs text-fg-muted">
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
            className={`${INPUT_CLASS} w-28`}
          />
          {unit}
        </label>
      ) : (
        <p className="pl-6 text-xs text-fg-subtle">{offHint}</p>
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
    <section className="rounded-md bg-sunken p-2.5 text-xs">
      <h4 className="mb-1 font-semibold text-fg-muted">At {metrics.environment.label}</h4>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-fg-muted">{term}</dt>
            <dd className="text-right text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The pool each caller instance keeps to every copy it calls, and how full it is. */
function ConnectionPool({ connection }: { readonly connection: Connection }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const { metrics } = useScenarioLoad();
  const value = connection.policy.poolSize ?? DEFAULT_POOL_SIZE;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Math.round(Number(draft));
    if (!Number.isFinite(parsed) || parsed < 1) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(MAX_POOL_SIZE, parsed);
    setDraft(String(next));
    if (next !== value) dispatch("setConnectionPolicy", { id: connection.id, poolSize: next });
  };
  const pool = metrics?.pools.get(connection.id);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1">
        <SectionTitle>Connection pool</SectionTitle>
      </legend>
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        <input
          type="number"
          min={1}
          max={MAX_POOL_SIZE}
          value={draft}
          aria-label="Pool size (connections to each copy)"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          className={`${INPUT_CLASS} w-20`}
        />
        connections from each instance to each copy it calls
      </label>
      <p className="text-xs text-fg-subtle">
        A connection runs one statement at a time, so the pool holds calls a second × their latency
        (Little's law). Calls beyond it wait for a connection.{" "}
        {connection.policy.poolSize === undefined &&
          `${DEFAULT_POOL_SIZE} is the default of HikariCP and node-postgres.`}
      </p>
      {metrics && pool && <PoolMetricsTable label={metrics.environment.label} pool={pool} />}
    </fieldset>
  );
}

function PoolMetricsTable({ label, pool }: { readonly label: string; readonly pool: PoolMetrics }) {
  const rows: [string, string][] = [
    ["In flight per instance", compact(pool.inFlight)],
    [
      "Connections per instance",
      pool.copies > 1
        ? `${compact(pool.poolSize * pool.copies)} (${pool.poolSize} × ${pool.copies} copies)`
        : compact(pool.poolSize),
    ],
    ["Busy", percent(pool.utilization, 0)],
  ];
  if (pool.waitMs >= 0.05) rows.push(["Wait for a connection", milliseconds(pool.waitMs)]);
  if (pool.exhausted > 0.0001) rows.push(["Calls finding none free", percent(pool.exhausted, 1)]);
  if (pool.proxied) rows.push(["Held by", "the connection proxy"]);
  return (
    <section className="rounded-md bg-sunken p-2.5 text-xs">
      <h4 className="mb-1 font-semibold text-fg-muted">At {label}</h4>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-fg-muted">{term}</dt>
            <dd className="text-right text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** "157 TB", "820 GB": data a month, in the unit that reads best. */
function dataSize(gb: number): string {
  return gb >= 1000 ? `${compact(gb / 1000)} TB` : `${compact(gb)} GB`;
}

/** Zone-aware routing for a hop inside the region, and what crosses zones over it. */
function ZoneRouting({ connection }: { readonly connection: Connection }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const attempt = useAttemptStore((s) => s.attempt);
  const { metrics } = useScenarioLoad();
  // Hops from clients start outside the region; in-process components have no hop.
  if (!zoneRoutes(attempt, catalogIndex).has(connection.id)) return null;
  const on = connection.policy.sameZone;
  const traffic = metrics?.zoneTraffic.get(connection.id);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1">
        <SectionTitle>Zones</SectionTitle>
      </legend>
      <Checkbox
        label="Zone-aware routing (prefer the target in the caller's zone)"
        checked={on}
        onChange={(sameZone) => dispatch("setConnectionPolicy", { id: connection.id, sameZone })}
      />
      <p className="pl-6 text-xs text-fg-subtle">
        {on
          ? "Calls stay in the caller's zone as far as the target's instances there can take them evenly. Writes still go to the primary."
          : "Calls go to any of the target's instances, in whichever zone. Crossing zones adds most of a millisecond, and the data that crosses is billed $0.01 a GB at each end that runs on EC2."}
      </p>
      {metrics && traffic && (
        <ZoneTrafficMetrics label={metrics.environment.label} traffic={traffic} />
      )}
    </fieldset>
  );
}

function ZoneTrafficMetrics({
  label,
  traffic,
}: {
  readonly label: string;
  readonly traffic: ConnectionZoneMetrics;
}) {
  const sameShare = Math.abs(traffic.crossRead - traffic.crossWrite) < 0.005;
  const rows: [string, string][] = [
    [
      "Calls crossing zones",
      sameShare
        ? percent(traffic.crossRead, 0)
        : `reads ${percent(traffic.crossRead, 0)}, writes ${percent(traffic.crossWrite, 0)}`,
    ],
    ["Round trip", milliseconds(traffic.roundTripMs.read)],
  ];
  if (traffic.crossGbPerMonth >= 1) {
    rows.push(["Data between zones", `${dataSize(traffic.crossGbPerMonth)}/month`]);
    rows.push([
      "Transfer cost",
      traffic.usdPerGb === 0 ? "free on this hop" : `${usd(traffic.monthlyCost)}/month`,
    ]);
  }
  if (traffic.avoidableMonthlyCost >= 1) {
    rows.push(["Zone-aware routing would save", `${usd(traffic.avoidableMonthlyCost)}/month`]);
  }
  return (
    <section className="rounded-md bg-sunken p-2.5 text-xs">
      <h4 className="mb-1 font-semibold text-fg-muted">At {label}</h4>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-fg-muted">{term}</dt>
            <dd className="text-right text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
