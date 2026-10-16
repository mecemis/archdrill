import type { ConnectionZoneMetrics } from "@archdrill/engine";
import { z } from "zod";
import type { Evidence } from "../evidence";
import { type CheckContext, defineCheck, failed, notApplicable, passed } from "./types";

const usd = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
const percent = (value: number) => `${Math.round(value * 100)}%`;

function route(ctx: CheckContext, connectionId: string): string {
  const connection = ctx.attempt.architecture.connections.find((c) => c.id === connectionId);
  if (!connection) return connectionId;
  const label = (id: string) =>
    ctx.attempt.architecture.components.find((c) => c.id === id)?.label ?? id;
  return `${label(connection.from)} → ${label(connection.to)}`;
}

/** How a connection's calls cross zones, reads and writes apart where both carry data and differ. */
function crossing(traffic: ConnectionZoneMetrics): string {
  const { read, write } = traffic.bytesPerSec;
  const differ = Math.abs(traffic.crossRead - traffic.crossWrite) >= 0.005;
  if (read > 0 && write > 0 && differ) {
    return `${percent(traffic.crossRead)} of reads and ${percent(traffic.crossWrite)} of writes cross zones`;
  }
  const share = write > 0 && read === 0 ? traffic.crossWrite : traffic.crossRead;
  return `${percent(share)} of calls cross zones`;
}

/**
 * Calls stay in their zone where zone-aware routing could keep them there:
 * no connection pays more than `minMonthlyUsd` a month for traffic between
 * zones that it would not pay with it.
 */
export const zoneLocalCalls = defineCheck({
  id: "zone-local-calls",
  description: "Calls stay in their zone wherever zone-aware routing can keep them there.",
  params: z.strictObject({
    environment: z.string().min(1),
    /** Savings below this, in USD a month, are not worth a finding. */
    minMonthlyUsd: z.number().nonnegative().default(100),
  }),
  run(params, ctx) {
    const env = ctx.metrics.get(params.environment);
    if (!env) return notApplicable("This scenario does not simulate load.");
    const traffic = [...env.zoneTraffic.values()];
    const total = traffic.reduce((sum, t) => sum + t.monthlyCost, 0);
    if (traffic.every((t) => t.monthlyCost === 0)) {
      return notApplicable("No billed traffic crosses zones.");
    }
    const avoidable = traffic
      .filter((t) => t.avoidableMonthlyCost >= params.minMonthlyUsd)
      .sort((a, b) => b.avoidableMonthlyCost - a.avoidableMonthlyCost);
    if (avoidable.length === 0) {
      return passed(
        `Traffic between zones costs ${usd(total)}/month at ${env.environment.label}, none of it that zone-aware routing would save.`,
      );
    }
    const saving = avoidable.reduce((sum, t) => sum + t.avoidableMonthlyCost, 0);
    const details = avoidable.map(
      (t) =>
        `${route(ctx, t.connectionId)}: ${crossing(t)}, ${usd(t.avoidableMonthlyCost)}/month that zone-aware routing would save`,
    );
    const evidence: Evidence[] = avoidable.map((t) => ({
      type: "connection",
      connectionId: t.connectionId,
    }));
    return failed(
      `Traffic between zones costs ${usd(total)}/month at ${env.environment.label}; zone-aware routing would save ${usd(saving)} of it.`,
      evidence,
      details,
    );
  },
});
