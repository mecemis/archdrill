import type { ComponentMetrics, EnvironmentMetrics } from "@archdrill/engine";
import { MAX_DELIVERIES } from "@archdrill/engine";
import { AlertTriangle } from "lucide-react";
import { activePack } from "../../state/content";
import { useScenarioLoad } from "../../state/evaluation";
import { useAttemptStore } from "../../state/store";
import { EMPTY_HIGHLIGHT, useUi } from "../../state/ui-store";
import { useWhatIf } from "../../state/what-if";
import { factorLabel } from "../../state/what-if-compute";
import { compact, milliseconds, percent, usd, utilizationTone } from "../../ui/format";
import { Tabs } from "../../ui/primitives";
import { componentLabel } from "../flow/step-label";

/** Simulated load, latency, cache behaviour and cost for the selected environment. */
export function LoadPanel() {
  const { environments, environmentId, metrics, whatIf } = useScenarioLoad();
  const setEnvironment = useUi((s) => s.setEnvironment);
  if (environments.length === 0) {
    return <p className="p-3 text-sm text-fg-subtle">This scenario does not simulate load.</p>;
  }
  return (
    <div className="flex flex-col gap-4 p-3">
      <Tabs
        label="Environment"
        value={environmentId ?? ""}
        onChange={(id) => setEnvironment(id)}
        options={environments.map((e) => ({ id: e.id, label: e.label }))}
      />
      {whatIf && (
        <p
          className="flex items-center gap-2 self-start rounded-lg border border-warn-line bg-warn-soft px-2.5 py-1 text-xs text-warn-fg"
          data-testid="load-what-if"
        >
          What if: {factorLabel(whatIf.factor)} the traffic
          {whatIf.updating ? " (simulating…)" : ""}. These numbers are not scored.
          <button
            type="button"
            className="font-medium underline"
            onClick={() => useWhatIf.getState().setFactor(1)}
          >
            Back to {factorLabel(1)}
          </button>
        </p>
      )}
      {metrics ? (
        <LoadDetails metrics={metrics} />
      ) : (
        <p className="text-sm text-fg-subtle">Load appears once the scenario can be evaluated.</p>
      )}
    </div>
  );
}

function LoadDetails({ metrics }: { readonly metrics: EnvironmentMetrics }) {
  return (
    <>
      <EnvironmentSummary metrics={metrics} />
      {!metrics.converged && (
        <p className="flex gap-1.5 rounded-md bg-warn-soft px-2.5 py-2 text-xs text-warn-fg">
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

/** Backlog growth below this share of the arrival rate counts as keeping up. */
const BACKLOG_TOLERANCE = 1e-3;

function OperationsTable({ metrics }: { readonly metrics: EnvironmentMetrics }) {
  const operations = [...metrics.operations.values()];
  const background = operations.filter((op) => op.trigger !== "request");
  const labelOf = (id: string) =>
    activePack.problem.operations.find((o) => o.id === id)?.label ?? id;
  const notes = background.flatMap((op) => {
    const lines: string[] = [];
    if (op.backlogGrowth > BACKLOG_TOLERANCE * op.rate)
      lines.push(
        `${labelOf(op.operation)} falls behind by ${compact(op.backlogGrowth)}/s: its backlog grows and the lag with it.`,
      );
    if (op.redeliveries > 0.5)
      lines.push(
        `${labelOf(op.operation)} gets ${compact(op.redeliveries)}/s failed messages again; after ${MAX_DELIVERIES} deliveries they go to a dead-letter queue.`,
      );
    return lines;
  });
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold text-fg-muted">Operations</h4>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-fg-subtle">
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
          {operations.map((op) => {
            const label = labelOf(op.operation);
            return (
              <tr key={op.operation} className="tabular-nums">
                <td className="py-0.5">
                  {label}
                  {op.trigger !== "request" && (
                    <span className="text-xs text-fg-subtle">
                      {" "}
                      · {op.trigger === "event" ? "consumer" : "job"}
                    </span>
                  )}
                </td>
                <td>{compact(op.rate)}/s</td>
                {op.rate > 0 ? (
                  <td className={op.successRate < 0.9999 ? "font-semibold text-bad-fg" : ""}>
                    {percent(op.successRate, 2)}
                  </td>
                ) : (
                  <td className="text-fg-subtle">nothing arrives</td>
                )}
                {(["p50", "p95", "p99"] as const).map((p) => (
                  <td key={p}>
                    {op.rate > 0 && op.successRate > 0 ? milliseconds(op.latency[p]) : "—"}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {background.length > 0 && (
        <p className="mt-1 text-xs text-fg-subtle">
          For consumers and jobs, latency is the lag from when the item is ready until it is done,
          waiting for batches included.
        </p>
      )}
      {notes.map((note) => (
        <p key={note} className="mt-1 text-xs font-medium text-bad-fg">
          {note}
        </p>
      ))}
    </section>
  );
}

function ComponentsTable({ metrics }: { readonly metrics: EnvironmentMetrics }) {
  const attempt = useAttemptStore((s) => s.attempt);
  const rows = [...metrics.components.values()].sort((a, b) => b.utilization - a.utilization);
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold text-fg-muted">Components</h4>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-fg-subtle">
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

/** What sets a load balancer's capacity units, for people. */
function unitDriver(units: NonNullable<ComponentMetrics["capacityUnits"]>): string {
  switch (units.by) {
    case "new-connections":
      return `${compact(units.newConnectionsPerSec)} new connections a second`;
    case "active-connections":
      return `${compact(units.activeConnections)} open connections`;
    case "processed-bytes":
      return `${compact(units.processedGbPerHour)} GB processed an hour`;
  }
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
      className="tabular-nums hover:bg-muted"
      onMouseEnter={() => setHover(highlight)}
      onMouseLeave={() => setHover(null)}
    >
      <td className="py-0.5">
        {label}
        {metrics.faults.length > 0 && (
          <span className="block text-xs font-medium text-bad-fg">{metrics.faults.join("; ")}</span>
        )}
      </td>
      <td title={`${compact(metrics.readLoad)} reads/s, ${compact(metrics.writeLoad)} writes/s`}>
        {compact(load)}/s
        {metrics.retryLoad > 0 && load > 0 && (
          <span className="block text-xs text-warn-fg">
            {percent(metrics.retryLoad / load, 0)} retries
          </span>
        )}
      </td>
      <td>
        <span className="flex items-center gap-2">
          <span className="h-2 w-24 overflow-hidden rounded-full bg-track" aria-hidden="true">
            <span
              className={`block h-full rounded-full ${utilizationTone(metrics.utilization)}`}
              style={{ width: `${Math.min(100, metrics.utilization * 100)}%` }}
            />
          </span>
          <span className={metrics.utilization > 1 ? "font-semibold text-bad-fg" : ""}>
            {percent(metrics.utilization, 0)}
          </span>
        </span>
        {metrics.hottestShardUtilization > metrics.utilization + 0.05 && (
          <span
            className={`block text-xs ${metrics.hottestShardUtilization > 1 ? "font-semibold text-bad-fg" : "text-warn-fg"}`}
          >
            hot shard {percent(metrics.hottestShardUtilization, 0)}
          </span>
        )}
        {metrics.networkUtilization >=
          Math.max(metrics.utilization, metrics.hottestShardUtilization) - 1e-9 &&
          metrics.networkUtilization > 0.05 && (
            <span
              className={`block text-xs ${metrics.networkUtilization > 1 ? "font-semibold text-bad-fg" : "text-fg-subtle"}`}
              title={`It sends ${compact(metrics.bytesOut / 1e6)} MB/s`}
            >
              limited by its network
            </span>
          )}
        {metrics.disk && metrics.disk.utilization > 0.05 && (
          <span
            className={`block text-xs ${metrics.disk.utilization > 1 ? "font-semibold text-bad-fg" : "text-fg-subtle"}`}
            title={`Its page cache answers ${percent(metrics.disk.hitRatio, 1)} of reads; the rest read their pages from the volume, ${compact(metrics.disk.readIops + metrics.disk.writeIops)} of the ${compact(metrics.disk.limit)} I/Os a second one copy sustains`}
          >
            volume {percent(metrics.disk.utilization, 0)}
            {metrics.disk.utilization >=
              Math.max(metrics.utilization, metrics.hottestShardUtilization) - 1e-9 &&
              " (limits it)"}
          </span>
        )}
        {metrics.connections && (
          <span
            className={`block text-xs ${metrics.connections.open > metrics.connections.limit ? "font-semibold text-bad-fg" : "text-fg-subtle"}`}
            title="Connections its callers' pools hold on its fullest instance, and how many one instance accepts"
          >
            {compact(metrics.connections.open)} / {compact(metrics.connections.limit)} connections
          </span>
        )}
      </td>
      <td>{milliseconds(metrics.latency.mean)}</td>
      <td>
        {usd(metrics.monthlyCost)}
        {autoscaled && (
          <span className="block text-xs text-fg-subtle">{metrics.instances} instances</span>
        )}
        {metrics.capacityUnits && metrics.costBreakdown.capacityUnits >= 1 && (
          <span
            className="block text-xs text-fg-subtle"
            title={`${usd(metrics.costBreakdown.capacityUnits)}/month, set by ${unitDriver(metrics.capacityUnits)}`}
          >
            {compact(metrics.capacityUnits.units)} capacity units
          </span>
        )}
        {metrics.costBreakdown.crossZone >= 1 && (
          <span
            className="block text-xs text-fg-subtle"
            title="What its calls send and receive across zones costs, both ends' share"
          >
            {usd(metrics.costBreakdown.crossZone)} between zones
          </span>
        )}
        {metrics.costBreakdown.iops >= 1 && (
          <span
            className="block text-xs text-fg-subtle"
            title="I/Os provisioned on its volumes above what they include"
          >
            {usd(metrics.costBreakdown.iops)} provisioned I/Os
          </span>
        )}
        {metrics.costBreakdown.proxy >= 1 && (
          <span
            className="block text-xs text-fg-subtle"
            title="The connection proxy in front of it, billed per vCPU of its instances"
          >
            {usd(metrics.costBreakdown.proxy)} proxy
          </span>
        )}
        {metrics.costBreakdown.standbyRegion >= 1 && (
          <span
            className="block text-xs text-fg-subtle"
            title="Its copy in the standby region: instances, stored data, replicated writes and the data replicated to it"
          >
            {usd(metrics.costBreakdown.standbyRegion)} standby region
          </span>
        )}
        {metrics.costBreakdown.internet >= 1 && (
          <span
            className="block text-xs text-fg-subtle"
            title="Its answers to clients, its share of the Region's tiered price for data sent to the internet"
          >
            {usd(metrics.costBreakdown.internet)} to the internet
          </span>
        )}
      </td>
    </tr>
  );
}

/** What the environment represents and which components it breaks. */
function EnvironmentSummary({ metrics }: { readonly metrics: EnvironmentMetrics }) {
  const attempt = useAttemptStore((s) => s.attempt);
  // Components whose calls fail or slow down first; those that only lost instances after.
  const faulty = [...metrics.components.values()]
    .filter((c) => c.faults.length > 0)
    .sort((a, b) => Number(b.faultDisrupts) - Number(a.faultDisrupts));
  const { description, faults } = metrics.environment;
  if (!description && faults.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md bg-sunken px-2.5 py-2 text-xs text-fg-muted">
      {description && <p>{description}</p>}
      {faults.length > 0 && faulty.length === 0 && (
        <p className="text-fg-subtle">No component in this design is affected.</p>
      )}
      {faulty.map((c) => (
        <p
          key={c.componentId}
          className={`flex gap-1.5 font-medium ${c.faultDisrupts ? "text-bad-fg" : "text-warn-fg"}`}
        >
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
      <h4 className="mb-1 text-xs font-semibold text-fg-muted">Calls</h4>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-fg-subtle">
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
                <td className={c.attempts > 1.2 * c.calls ? "font-semibold text-warn-fg" : ""}>
                  ×{(c.attempts / c.calls).toFixed(2)}
                </td>
                <td className={c.failure > 0.001 ? "font-semibold text-bad-fg" : ""}>
                  {percent(c.failure, 2)}
                </td>
                <td className="text-xs text-fg-muted">{why.join(", ")}</td>
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
      <h4 className="mb-1 text-xs font-semibold text-fg-muted">Caches</h4>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-fg-subtle">
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
              <td className={c.populated ? "" : "font-semibold text-bad-fg"}>
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
      capacityUnits: sum.capacityUnits + c.costBreakdown.capacityUnits,
      storage: sum.storage + c.costBreakdown.storage,
      crossZone: sum.crossZone + c.costBreakdown.crossZone,
      standbyRegion: sum.standbyRegion + c.costBreakdown.standbyRegion,
      internet: sum.internet + c.costBreakdown.internet,
    }),
    {
      instances: 0,
      requests: 0,
      capacityUnits: 0,
      storage: 0,
      crossZone: 0,
      standbyRegion: 0,
      internet: 0,
    },
  );
  return (
    <section className="text-sm">
      <h4 className="mb-1 text-xs font-semibold text-fg-muted">Cost at this load</h4>
      <p className="tabular-nums">
        <span className="font-semibold">{usd(metrics.monthlyCost)}</span> / month · instances{" "}
        {usd(totals.instances)} · requests {usd(totals.requests)}
        {totals.capacityUnits >= 1 && <> · capacity units {usd(totals.capacityUnits)}</>} · storage{" "}
        {usd(totals.storage)}
        {totals.crossZone >= 1 && <> · between zones {usd(totals.crossZone)}</>}
        {totals.standbyRegion >= 1 && <> · standby region {usd(totals.standbyRegion)}</>}
        {totals.internet >= 1 && <> · to the internet {usd(totals.internet)}</>}
      </p>
      <p className="mt-1 text-xs text-fg-subtle">
        Ballpark list prices for comparing designs, not a quote. Storage counts every replica's
        copy.
      </p>
    </section>
  );
}
