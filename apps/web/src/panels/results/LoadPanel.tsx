import type { ComponentMetrics, EnvironmentMetrics } from "@archdrill/engine";
import { AlertTriangle } from "lucide-react";
import { activePack } from "../../state/content";
import { useScenarioLoad } from "../../state/evaluation";
import { useAttemptStore } from "../../state/store";
import { EMPTY_HIGHLIGHT, useUi } from "../../state/ui-store";
import { compact, milliseconds, percent, usd, utilizationTone } from "../../ui/format";
import { Tabs } from "../../ui/primitives";
import { componentLabel } from "../flow/step-label";

/** Simulated load, latency, cache behaviour and cost for the selected environment. */
export function LoadPanel() {
  const { environments, environmentId, metrics } = useScenarioLoad();
  const setEnvironment = useUi((s) => s.setEnvironment);
  if (environments.length === 0) {
    return <p className="p-3 text-sm text-zinc-500">This scenario does not simulate load.</p>;
  }
  return (
    <div className="flex flex-col gap-4 p-3">
      <Tabs
        label="Environment"
        value={environmentId ?? ""}
        onChange={(id) => setEnvironment(id)}
        options={environments.map((e) => ({ id: e.id, label: e.label }))}
      />
      {metrics ? (
        <LoadDetails metrics={metrics} />
      ) : (
        <p className="text-sm text-zinc-500">Load appears once the scenario can be evaluated.</p>
      )}
    </div>
  );
}

function LoadDetails({ metrics }: { readonly metrics: EnvironmentMetrics }) {
  return (
    <>
      <EnvironmentSummary metrics={metrics} />
      {!metrics.converged && (
        <p className="flex gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          The overload feedback did not settle; numbers are approximate. A component is far over
          capacity.
        </p>
      )}
      <OperationsTable metrics={metrics} />
      <ComponentsTable metrics={metrics} />
      <CallsTable metrics={metrics} />
      {metrics.caches.length > 0 && <CachesTable metrics={metrics} />}
      <CostSummary metrics={metrics} />
    </>
  );
}

function OperationsTable({ metrics }: { readonly metrics: EnvironmentMetrics }) {
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold text-zinc-600">Operations</h4>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="font-medium">Operation</th>
            <th className="font-medium">Rate</th>
            <th className="font-medium">Success</th>
            <th className="font-medium">p50</th>
            <th className="font-medium">p95</th>
            <th className="font-medium">p99</th>
          </tr>
        </thead>
        <tbody>
          {[...metrics.operations.values()].map((op) => {
            const label =
              activePack.problem.operations.find((o) => o.id === op.operation)?.label ??
              op.operation;
            return (
              <tr key={op.operation} className="tabular-nums">
                <td className="py-0.5">{label}</td>
                <td>{compact(op.rate)}/s</td>
                <td className={op.successRate < 0.9999 ? "font-semibold text-rose-700" : ""}>
                  {percent(op.successRate, 2)}
                </td>
                <td>{milliseconds(op.latency.p50)}</td>
                <td>{milliseconds(op.latency.p95)}</td>
                <td>{milliseconds(op.latency.p99)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function ComponentsTable({ metrics }: { readonly metrics: EnvironmentMetrics }) {
  const attempt = useAttemptStore((s) => s.attempt);
  const rows = [...metrics.components.values()].sort((a, b) => b.utilization - a.utilization);
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold text-zinc-600">Components</h4>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="font-medium">Component</th>
            <th className="font-medium">Load</th>
            <th className="w-40 font-medium">Utilisation</th>
            <th className="font-medium">Latency</th>
            <th className="font-medium">Cost / month</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <ComponentRow
              key={c.componentId}
              metrics={c}
              label={componentLabel(attempt, c.componentId)}
              autoscaled={
                attempt.architecture.components.find((x) => x.id === c.componentId)?.autoscale !==
                undefined
              }
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ComponentRow({
  metrics,
  label,
  autoscaled,
}: {
  readonly metrics: ComponentMetrics;
  readonly label: string;
  readonly autoscaled: boolean;
}) {
  const highlight = { ...EMPTY_HIGHLIGHT, components: new Set([metrics.componentId]) };
  const { setHover } = useUi.getState();
  const load = metrics.readLoad + metrics.writeLoad;
  return (
    <tr
      className="tabular-nums hover:bg-zinc-100"
      onMouseEnter={() => setHover(highlight)}
      onMouseLeave={() => setHover(null)}
    >
      <td className="py-0.5">
        {label}
        {metrics.faults.length > 0 && (
          <span className="block text-xs font-medium text-rose-700">
            {metrics.faults.join("; ")}
          </span>
        )}
      </td>
      <td title={`${compact(metrics.readLoad)} reads/s, ${compact(metrics.writeLoad)} writes/s`}>
        {compact(load)}/s
        {metrics.retryLoad > 0 && load > 0 && (
          <span className="block text-xs text-amber-700">
            {percent(metrics.retryLoad / load, 0)} retries
          </span>
        )}
      </td>
      <td>
        <span className="flex items-center gap-2">
          <span className="h-2 w-24 overflow-hidden rounded-full bg-zinc-200" aria-hidden="true">
            <span
              className={`block h-full rounded-full ${utilizationTone(metrics.utilization)}`}
              style={{ width: `${Math.min(100, metrics.utilization * 100)}%` }}
            />
          </span>
          <span className={metrics.utilization > 1 ? "font-semibold text-rose-700" : ""}>
            {percent(metrics.utilization, 0)}
          </span>
        </span>
        {metrics.hottestShardUtilization > metrics.utilization + 0.05 && (
          <span
            className={`block text-xs ${metrics.hottestShardUtilization > 1 ? "font-semibold text-rose-700" : "text-amber-700"}`}
          >
            hot shard {percent(metrics.hottestShardUtilization, 0)}
          </span>
        )}
      </td>
      <td>{milliseconds(metrics.latency.mean)}</td>
      <td>
        {usd(metrics.monthlyCost)}
        {autoscaled && (
          <span className="block text-xs text-zinc-500">{metrics.instances} instances</span>
        )}
      </td>
    </tr>
  );
}

/** What the environment represents and which components it breaks. */
function EnvironmentSummary({ metrics }: { readonly metrics: EnvironmentMetrics }) {
  const attempt = useAttemptStore((s) => s.attempt);
  const faulty = [...metrics.components.values()].filter((c) => c.faults.length > 0);
  const { description, faults } = metrics.environment;
  if (!description && faults.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md bg-zinc-50 px-2.5 py-2 text-xs text-zinc-700">
      {description && <p>{description}</p>}
      {faults.length > 0 && faulty.length === 0 && (
        <p className="text-zinc-500">No component in this design is affected.</p>
      )}
      {faulty.map((c) => (
        <p key={c.componentId} className="flex gap-1.5 font-medium text-rose-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {componentLabel(attempt, c.componentId)}: {c.faults.join("; ")}
        </p>
      ))}
    </div>
  );
}

/** Calls flow steps make over each connection, after timeouts, retries, breakers and bulkheads. */
function CallsTable({ metrics }: { readonly metrics: EnvironmentMetrics }) {
  const attempt = useAttemptStore((s) => s.attempt);
  const rows = [...metrics.calls.values()].filter((c) => c.calls > 0);
  if (rows.length === 0) return null;
  const route = (id: string) => {
    const connection = attempt.architecture.connections.find((c) => c.id === id);
    if (!connection) return id;
    return `${componentLabel(attempt, connection.from)} → ${componentLabel(attempt, connection.to)}`;
  };
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold text-zinc-600">Calls</h4>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="font-medium">Connection</th>
            <th className="font-medium">Calls</th>
            <th className="font-medium">Attempts</th>
            <th className="font-medium">Failing</th>
            <th className="font-medium">Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const why = [
              c.timedOut > 0.0001 ? `${percent(c.timedOut, 1)} time out` : null,
              c.shortCircuit > 0.0001 ? `breaker open for ${percent(c.shortCircuit, 0)}` : null,
              c.shed > 0.0001 ? `bulkhead rejects ${percent(c.shed, 0)}` : null,
            ].filter((w): w is string => w !== null);
            return (
              <tr key={c.connectionId} className="tabular-nums">
                <td className="py-0.5">{route(c.connectionId)}</td>
                <td>{compact(c.calls)}/s</td>
                <td className={c.attempts > 1.2 * c.calls ? "font-semibold text-amber-700" : ""}>
                  ×{(c.attempts / c.calls).toFixed(2)}
                </td>
                <td className={c.failure > 0.001 ? "font-semibold text-rose-700" : ""}>
                  {percent(c.failure, 2)}
                </td>
                <td className="text-xs text-zinc-600">{why.join(", ")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function CachesTable({ metrics }: { readonly metrics: EnvironmentMetrics }) {
  const attempt = useAttemptStore((s) => s.attempt);
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold text-zinc-600">Caches</h4>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="font-medium">Cache</th>
            <th className="font-medium">Hit ratio</th>
            <th className="font-medium">Negative hits</th>
            <th className="font-medium">Holds</th>
            <th className="font-medium">TTL</th>
          </tr>
        </thead>
        <tbody>
          {metrics.caches.map((c) => (
            <tr key={`${c.componentId}|${c.entity}`} className="tabular-nums">
              <td className="py-0.5">
                {componentLabel(attempt, c.componentId)} · {c.entity}
              </td>
              <td className={c.populated ? "" : "font-semibold text-rose-700"}>
                {c.populated ? percent(c.hitRatio) : "never populated"}
              </td>
              <td>{percent(c.negativeHitRatio)}</td>
              <td>{compact(c.capacityItems)} entries</td>
              <td>{c.ttlSec === null ? "none" : `${compact(c.ttlSec)} s`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CostSummary({ metrics }: { readonly metrics: EnvironmentMetrics }) {
  const totals = [...metrics.components.values()].reduce(
    (sum, c) => ({
      instances: sum.instances + c.costBreakdown.instances,
      requests: sum.requests + c.costBreakdown.requests,
      storage: sum.storage + c.costBreakdown.storage,
    }),
    { instances: 0, requests: 0, storage: 0 },
  );
  return (
    <section className="text-sm">
      <h4 className="mb-1 text-xs font-semibold text-zinc-600">Cost at this load</h4>
      <p className="tabular-nums">
        <span className="font-semibold">{usd(metrics.monthlyCost)}</span> / month · instances{" "}
        {usd(totals.instances)} · requests {usd(totals.requests)} · storage {usd(totals.storage)}
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        Ballpark list prices for comparing designs, not a quote. Storage counts every replica's
        copy.
      </p>
    </section>
  );
}
