import type { CatalogIndex, Component } from "@archdrill/model";

/*
 * Which stores can answer a read with less than the latest acknowledged
 * write: a replica that has not applied it yet, or an eventually consistent
 * read (ADR 0017).
 */

/**
 * Why an ordinary (not consistent) read of the store can miss a write
 * acknowledged moments ago, or null when it cannot. `replication` is the
 * replication mode the design decided for stores with a primary.
 */
export function staleReadReason(
  component: Component,
  catalog: CatalogIndex,
  replication: string | undefined,
): string | null {
  const kind = catalog.kind(component.kind);
  const flavor = catalog.flavor(component.kind, component.flavor);
  if (!kind?.holdsData || !flavor) return null;
  if (flavor.managedRedundancy) {
    return "its reads are eventually consistent unless they ask for a strongly consistent read";
  }
  if (!kind.replicable || component.replicas < 2) return null;
  if (kind.quorum) return "a read from one replica can miss a write the others have";
  if (kind.writeScaling !== "primaries") return null;
  if (replication === "sync") return null;
  return replication === "semi-sync"
    ? "with semi-synchronous replication, one replica has received the write, but replicas may not have applied it yet"
    : "its replicas apply writes after the primary has acknowledged them";
}
