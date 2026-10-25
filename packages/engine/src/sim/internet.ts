import {
  type Attempt,
  type CatalogIndex,
  type InternetTransfer,
  runsInRegion,
  type TransferTier,
} from "@archdrill/model";
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
 * The price a component's sends to clients fall under: its offering's own (a
 * CDN's edge locations), else the Region's for what runs in it; nothing for
 * what runs elsewhere.
 */
function priceOf(id: string, attempt: Attempt, catalog: CatalogIndex): InternetTransfer | null {
  const component = attempt.architecture.components.find((c) => c.id === id);
  const kind = component && catalog.kind(component.kind);
  const flavor = component && catalog.flavor(component.kind, component.flavor);
  if (!kind || !flavor) return null;
  if (flavor.internetTransfer) return flavor.internetTransfer;
  return runsInRegion(kind, flavor) ? (catalog.catalog.internetTransfer ?? null) : null;
}

/**
 * What each component pays a month for what it sends to clients over the
 * internet. Each price's tiers apply to the month's total from every
 * component billed under it, and each pays its share of that bill.
 */
export function internetTransferCosts(
  toClients: ReadonlyMap<string, number>,
  attempt: Attempt,
  catalog: CatalogIndex,
): Map<string, number> {
  const byPrice = new Map<InternetTransfer, [string, number][]>();
  for (const [id, bytes] of toClients) {
    const price = bytes > 0 ? priceOf(id, attempt, catalog) : null;
    if (price) byPrice.set(price, [...(byPrice.get(price) ?? []), [id, bytes]]);
  }
  const costs = new Map<string, number>();
  for (const [price, senders] of byPrice) {
    const total = senders.reduce((sum, [, bytes]) => sum + bytes, 0);
    const bill = tieredCost((total * SECONDS_PER_MONTH) / BYTES_PER_GB, price.tiers);
    for (const [id, bytes] of senders) costs.set(id, (bill * bytes) / total);
  }
  return costs;
}
