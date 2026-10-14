import type { Flavor, Provenance, Size, Source } from "@archdrill/model";
import { BookCheck, ExternalLink, FlaskConical } from "lucide-react";
import { catalogIndex } from "../state/content";
import { compact } from "../ui/format";

type Field =
  | "capacityPerSec"
  | "latencyMs"
  | "costPerHour"
  | "memoryGb"
  | "maxConnections"
  | "storagePricePerGbMonth"
  | "requestCost"
  | "perKeyCapacityPerSec"
  | "startupSec";

const FIELDS: readonly { readonly field: Field; readonly label: string }[] = [
  { field: "costPerHour", label: "Price" },
  { field: "requestCost", label: "Request price" },
  { field: "storagePricePerGbMonth", label: "Storage price" },
  { field: "capacityPerSec", label: "Throughput" },
  { field: "perKeyCapacityPerSec", label: "Per-key limit" },
  { field: "maxConnections", label: "Connections" },
  { field: "memoryGb", label: "Memory" },
  { field: "latencyMs", label: "Latency" },
  { field: "startupSec", label: "Startup" },
];

/** A price as the source states it: $1.424, $0.115, $0.0225, never rounded away. */
const price = (value: number) => (value === 0 ? "$0" : `$${Number(value.toPrecision(4))}`);

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
      return flavor.requestCost
        ? `${price(flavor.requestCost.readPerMillion)} per million reads, ${price(flavor.requestCost.writePerMillion)} per million writes`
        : null;
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
    case "latencyMs":
      return size ? `${size.latencyMs.base} ms` : null;
    case "startupSec":
      return flavor.startupSec === undefined ? null : `${flavor.startupSec} s`;
  }
}

function SourceLink({ source }: { readonly source: Source }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-0.5 text-accent-fg underline decoration-accent-line underline-offset-2 hover:decoration-accent"
      title={`${source.title} (${source.publisher}, read ${source.retrieved}${source.via ? `, via ${source.via}` : ""})`}
    >
      {source.publisher}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );
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
      </div>
    </details>
  );
}
