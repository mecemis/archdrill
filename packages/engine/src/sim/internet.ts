import { type Attempt, type CatalogIndex, runsInRegion, type TransferTier } from "@archdrill/model";
import { SECONDS_PER_MONTH } from "./capacity";

const BYTES_PER_GB = 1e9;

/** What a month's GB cost under tiered prices: each GB at the tier it falls in. */
export function tieredCost(gb: number, tiers: readonly TransferTier[]): number {
  let cost = 0;
  tiers.forEach((tier, i) => {
    const next = tiers[i + 1]?.fromGb ?? Number.POSITIVE_INFINITY;
    const inTier = Math.min(gb, next) - tier.fromGb;
    if (inTier > 0) cost += inTier * tier.usdPerGb;
  });
  return cost;
}

/**
 * What each component pays a month for what it sends to clients over the
 * internet. The Region's tiers apply to the month's total from every
 * component in it, and each pays its share of the bill.
 */
export function internetTransferCosts(
  toClients: ReadonlyMap<string, number>,
  attempt: Attempt,
  catalog: CatalogIndex,
): Map<string, number> {
  const transfer = catalog.catalog.internetTransfer;
  const costs = new Map<string, number>();
  if (!transfer) return costs;
  const senders = [...toClients].filter(([id, bytes]) => {
    const component = attempt.architecture.components.find((c) => c.id === id);
    const kind = component && catalog.kind(component.kind);
    const flavor = component && catalog.flavor(component.kind, component.flavor);
    return bytes > 0 && kind !== undefined && flavor !== undefined && runsInRegion(kind, flavor);
  });
  const total = senders.reduce((sum, [, bytes]) => sum + bytes, 0);
  if (total <= 0) return costs;
  const bill = tieredCost((total * SECONDS_PER_MONTH) / BYTES_PER_GB, transfer.tiers);
  for (const [id, bytes] of senders) costs.set(id, (bill * bytes) / total);
  return costs;
}
