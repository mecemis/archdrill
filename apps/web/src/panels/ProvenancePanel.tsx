import { CROSS_ZONE_USD_PER_GB } from "@archdrill/engine";
import type { Flavor, Provenance, Size, Source } from "@archdrill/model";
import { BookCheck, FlaskConical } from "lucide-react";
import { catalogIndex } from "../state/content";
import { compact } from "../ui/format";
import { CalibrationList } from "./CalibrationList";
import { SourceLink } from "./SourceLink";

type Field =
  | "capacityPerSec"
  | "latencyMs"
  | "costPerHour"
  | "memoryGb"
  | "maxConnections"
  | "networkGbps"
  | "storagePricePerGbMonth"
  | "requestCost"
  | "requestUnits"
  | "capacityUnits"
  | "perKeyCapacityPerSec"
  | "startupSec"
  | "failoverSec"
  | "crossZoneBilling"
  | "regionFailoverSec"
  | "crossRegionReplication";

const FIELDS: readonly { readonly field: Field; readonly label: string }[] = [
  { field: "costPerHour", label: "Price" },
  { field: "requestCost", label: "Request price" },
  { field: "requestUnits", label: "Request units" },
  { field: "capacityUnits", label: "Capacity units" },
  { field: "storagePricePerGbMonth", label: "Storage price" },
  { field: "capacityPerSec", label: "Throughput" },
  { field: "perKeyCapacityPerSec", label: "Per-key limit" },
  { field: "maxConnections", label: "Connections" },
  { field: "memoryGb", label: "Memory" },
  { field: "networkGbps", label: "Network" },
  { field: "latencyMs", label: "Latency" },
  { field: "startupSec", label: "Startup" },
  { field: "failoverSec", label: "Failover" },
  { field: "crossZoneBilling", label: "Between zones" },
  { field: "regionFailoverSec", label: "Standby promotion" },
  { field: "crossRegionReplication", label: "Standby region" },
];

/** What data crossing zones costs at a flavor's end. */
const CROSS_ZONE_BILLING: Readonly<Record<NonNullable<Flavor["crossZoneBilling"]>, string>> = {
  "each-end": `${price(CROSS_ZONE_USD_PER_GB)} a GB sent or received across zones`,
  "other-end": `free at its end; the other end pays ${price(CROSS_ZONE_USD_PER_GB)} a GB`,
  free: "free on hops through it",
};

/** A price as the source states it: $1.424, $0.115, $0.0225, $0.50, never rounded away. */
function price(value: number): string {
  if (value === 0) return "$0";
  const digits = String(Number(value.toPrecision(4)));
  // Cents read as cents: $0.50, not $0.5.
  return `$${/\.\d$/.test(digits) ? `${digits}0` : digits}`;
}

/** Per-request prices as vendors quote them: per million when cheap, per 1,000 otherwise. */
export function requestPrice(cost: NonNullable<Flavor["requestCost"]>): string {
  const per = (perMillion: number) =>
    perMillion >= 100
      ? `${price(perMillion / 1000)} per 1,000`
      : `${price(perMillion)} per million`;
  return cost.readPerMillion === cost.writePerMillion
    ? `${per(cost.readPerMillion)} calls`
    : `${per(cost.readPerMillion)} reads, ${per(cost.writePerMillion)} writes`;
}

/** How a flavor counts units: "a read per 4 KB (½ unit), a write per 1 KB, per item". */
export function unitsText(units: NonNullable<Flavor["requestUnits"]>): string {
  const kb = (bytes: number) => `${bytes / 1024} KB`;
  const half =
    units.readUnits === 0.5
      ? " (½ unit)"
      : units.readUnits === 1
        ? ""
        : ` (${units.readUnits} units)`;
  const reads =
    units.readBytes === units.writeBytes && units.readUnits === 1
      ? `one per ${kb(units.readBytes)}`
      : `reads one per ${kb(units.readBytes)}${half}, writes one per ${kb(units.writeBytes)}`;
  return `${reads}, ${units.per === "item" ? "per item" : "per request's payload"}`;
}

/** What one capacity unit covers: "$0.008 an hour each: 25 new connections a second, 3,000 open, or 1 GB an hour". */
export function capacityUnitsText(units: NonNullable<Flavor["capacityUnits"]>): string {
  const count = (value: number) => value.toLocaleString("en-US");
  return `${price(units.pricePerHour)} an hour each: ${count(units.newConnectionsPerSec)} new connections a second, ${count(units.activeConnections)} open, or ${count(units.processedGbPerHour)} GB an hour`;
}

/** A number as it reads in the catalog, or null when the component has none. */
function catalogValue(field: Field, flavor: Flavor, size: Size | undefined): string | null {
  const rate = (r: { read?: number; write?: number } | undefined, unit: string) =>
    !r
      ? null
      : [r.read && `${compact(r.read)} reads`, r.write && `${compact(r.write)} writes`]
          .filter(Boolean)
          .join(", ")
          .concat(unit) || null;
  switch (field) {
    case "costPerHour":
      return size ? `${price(size.costPerHour)} an hour` : null;
    case "requestCost":
      return flavor.requestCost ? requestPrice(flavor.requestCost) : null;
    case "storagePricePerGbMonth":
      return flavor.storagePricePerGbMonth === undefined
        ? null
        : `${price(flavor.storagePricePerGbMonth)} per GB-month`;
    case "capacityPerSec":
      return size && Object.keys(size.capacityPerSec).length > 0
        ? rate(size.capacityPerSec, " a second")
        : null;
    case "perKeyCapacityPerSec":
      return rate(flavor.perKeyCapacityPerSec, " a second per key");
    case "maxConnections":
      return size?.maxConnections === undefined ? null : `${compact(size.maxConnections)} open`;
    case "memoryGb":
      return size?.memoryGb === undefined ? null : `${size.memoryGb} GB`;
    case "networkGbps":
      return size?.networkGbps === undefined ? null : `${size.networkGbps} Gbps each way`;
    case "requestUnits":
      return flavor.requestUnits ? unitsText(flavor.requestUnits) : null;
    case "capacityUnits":
      return flavor.capacityUnits ? capacityUnitsText(flavor.capacityUnits) : null;
    case "latencyMs":
      return size ? `${size.latencyMs.base} ms` : null;
    case "startupSec":
      return flavor.startupSec === undefined ? null : `${flavor.startupSec} s`;
    case "failoverSec":
      return flavor.failoverSec === undefined
        ? null
        : `${flavor.failoverSec} s until a replica takes writes`;
    case "crossZoneBilling":
      return flavor.crossZoneBilling === undefined
        ? null
        : CROSS_ZONE_BILLING[flavor.crossZoneBilling];
    case "regionFailoverSec":
      return flavor.regionFailoverSec === undefined
        ? null
        : `${flavor.regionFailoverSec} s until the standby copy takes writes`;
    case "crossRegionReplication":
      return flavor.crossRegionReplication ? "kept filled from the primary region" : null;
  }
}

function Entry({
  label,
  value,
  provenance,
}: {
  readonly label: string;
  readonly value: string;
  readonly provenance: Provenance;
}) {
  const sources = catalogIndex.catalog.sources;
  const find = (id: string) => sources.find((s) => s.id === id);
  const published = "published" in provenance;
  const cited = (published ? [provenance.published] : provenance.basis)
    .map(find)
    .filter((s): s is Source => s !== undefined);
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <span className="font-medium text-fg">{label}</span>
        <span className="text-fg-muted tabular-nums">{value}</span>
        <span
          className={`ml-auto inline-flex items-center gap-1 rounded px-1.5 text-[10px] font-semibold ${
            published ? "bg-ok-soft text-ok-fg" : "bg-warn-soft text-warn-fg"
          }`}
          title={
            published
              ? "Stated by the vendor or a measurement, with its source"
              : "How this catalog models it, with its reasoning"
          }
        >
          {published ? (
            <BookCheck className="h-3 w-3" aria-hidden="true" />
          ) : (
            <FlaskConical className="h-3 w-3" aria-hidden="true" />
          )}
          {published ? "published" : cited.length > 0 ? "model" : "assumption"}
        </span>
      </span>
      {(published ? provenance.note : provenance.model) && (
        <span className="text-fg-subtle">{published ? provenance.note : provenance.model}</span>
      )}
      {cited.length > 0 && (
        <span className="flex flex-wrap items-center gap-x-2 text-fg-subtle">
          {published ? "Source:" : "Based on:"}
          {cited.map((source) => (
            <SourceLink key={source.id} source={source} />
          ))}
          <span>
            · read{" "}
            {cited
              .map((s) => s.retrieved)
              .sort()
              .at(-1)}
          </span>
        </span>
      )}
    </li>
  );
}

/**
 * Where a component's numbers come from: the real offering it stands for,
 * and for each number whether a vendor states it or the catalog models it.
 */
export function ProvenancePanel({
  kind,
  flavor,
  sizeId,
}: {
  readonly kind: string;
  readonly flavor: string;
  readonly sizeId: string | undefined;
}) {
  const f = catalogIndex.flavor(kind, flavor);
  if (!f) return null;
  const size = sizeId ? f.sizes[sizeId] : undefined;
  const standsFor = size?.standsFor ?? f.standsFor;
  const entries = FIELDS.flatMap(({ field, label }) => {
    const value = catalogValue(field, f, size);
    const provenance = size?.provenance[field] ?? f.provenance[field];
    return value === null || !provenance ? [] : [{ field, label, value, provenance }];
  });
  if (!standsFor && entries.length === 0) return null;
  return (
    <details className="group rounded-lg border border-line bg-sunken px-2.5 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-fg-muted select-none hover:text-fg">
        Where these numbers come from
      </summary>
      <div className="mt-2 flex flex-col gap-2.5">
        {standsFor && (
          <p className="text-fg-muted">
            Stands for <span className="font-medium text-fg">{standsFor}</span>.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {entries.map(({ field, label, value, provenance }) => (
            <Entry key={field} label={label} value={value} provenance={provenance} />
          ))}
        </ul>
        <CalibrationList kind={kind} flavor={flavor} />
      </div>
    </details>
  );
}
