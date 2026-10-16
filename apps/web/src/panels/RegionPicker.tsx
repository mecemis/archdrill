import { type CatalogIndex, type Component, MAX_REGIONS } from "@archdrill/model";
import { catalogIndex } from "../state/content";
import { FOCUS_RING } from "../ui/primitives";

const REGION_OPTIONS = Array.from({ length: MAX_REGIONS }, (_, i) => i + 1);
const OPTION_LABELS: Readonly<Record<number, string>> = { 1: "Primary only", 2: "+ Standby" };

/** Whether a component keeps a standby copy in a second region, and what that copy does. */
export function RegionPicker({
  component,
  onChange,
}: {
  readonly component: Component;
  readonly onChange: (regions: number) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
      <legend className="mb-1.5">Regions</legend>
      <div className="inline-flex w-fit gap-0.5 rounded-lg bg-muted p-0.5">
        {REGION_OPTIONS.map((regions) => {
          const selected = regions === component.regions;
          return (
            <button
              key={regions}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(regions)}
              className={`h-7 rounded-md px-2.5 text-[13px] font-medium transition-colors ${FOCUS_RING} ${
                selected ? "bg-surface text-fg shadow-card" : "text-fg-subtle hover:text-fg"
              }`}
            >
              {OPTION_LABELS[regions] ?? regions}
            </button>
          );
        })}
      </div>
      <span className="font-normal text-fg-subtle">{regionHint(component, catalogIndex)}</span>
    </fieldset>
  );
}

const minutes = (sec: number) =>
  sec % 60 === 0 ? `${sec / 60} minute${sec === 60 ? "" : "s"}` : `${sec} s`;

/** What the component's copy in the standby region does, in a sentence. */
export function regionHint(component: Component, catalog: CatalogIndex): string {
  if (component.regions < 2) {
    return "Runs only in the primary region, so losing that region takes this down.";
  }
  const kind = catalog.kind(component.kind);
  const flavor = catalog.flavor(component.kind, component.flavor);
  if (!kind || !flavor) return "Keeps a standby copy in a second region.";
  if (kind.holdsData) {
    if (flavor.regionFailoverSec !== undefined) {
      return `A standby copy in a second region, replicated asynchronously. It takes writes once promoted, ${minutes(flavor.regionFailoverSec)} after the region is declared lost.`;
    }
    return "A copy in a second region that takes writes there too, replicated asynchronously.";
  }
  if (catalog.capabilities(component.kind, component.flavor).has("volatile-kv")) {
    return flavor.crossRegionReplication
      ? "A standby copy in a second region, kept filled from the primary one."
      : "A standby copy in a second region. Nothing fills it, so it takes traffic empty.";
  }
  if (kind.replicable && !flavor.managedRedundancy) {
    const count = component.replicas * (kind.shardable ? component.shards : 1);
    const instances = `${count} instance${count === 1 ? "" : "s"}`;
    return component.autoscale
      ? `A standby copy runs its minimum of ${instances}, and scales up once traffic arrives.`
      : `A standby copy runs the same ${instances}, idle until traffic arrives.`;
  }
  return "A standby copy in a second region takes traffic once DNS fails over.";
}
