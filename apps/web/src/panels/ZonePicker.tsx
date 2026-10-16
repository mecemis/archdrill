import { zoneLoss } from "@archdrill/engine";
import { type CatalogIndex, type Component, MAX_ZONES } from "@archdrill/model";
import { catalogIndex } from "../state/content";
import { FOCUS_RING } from "../ui/primitives";

const ZONE_OPTIONS = Array.from({ length: MAX_ZONES }, (_, i) => i + 1);

/** How many availability zones a component's instances are spread over, and what losing one does. */
export function ZonePicker({
  component,
  onChange,
}: {
  readonly component: Component;
  readonly onChange: (zones: number) => void;
}) {
  const instances = component.replicas * component.shards;
  return (
    <fieldset className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
      <legend className="mb-1.5">Zones</legend>
      <div className="inline-flex w-fit gap-0.5 rounded-lg bg-muted p-0.5">
        {ZONE_OPTIONS.map((zones) => {
          const selected = zones === component.zones;
          return (
            <button
              key={zones}
              type="button"
              aria-pressed={selected}
              disabled={zones > instances}
              title={zones > instances ? `Needs at least ${zones} instances` : undefined}
              onClick={() => onChange(zones)}
              className={`h-7 min-w-9 rounded-md px-2.5 text-[13px] font-medium tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING} ${
                selected ? "bg-surface text-fg shadow-card" : "text-fg-subtle hover:text-fg"
              }`}
            >
              {zones}
            </button>
          );
        })}
      </div>
      <span className="font-normal text-fg-subtle">{zoneHint(component, catalogIndex)}</span>
    </fieldset>
  );
}

/** What losing a zone does to the component, in a sentence. */
export function zoneHint(component: Component, catalog: CatalogIndex): string {
  if (component.zones === 1) {
    return "Every instance is in one zone, so losing that zone takes this down.";
  }
  const loss = zoneLoss(component, catalog);
  if (loss.keepsServing) {
    const lost = Math.round((1 - loss.capacityLeft) * 100);
    return `Losing a zone takes ${lost}% of its instances; the others carry on.`;
  }
  if (catalog.kind(component.kind)?.quorum && component.replicas >= 2) {
    const whose =
      component.shards > 1
        ? "some shards' replicas, which stops them"
        : "its replicas, which stops it";
    return `Losing a zone takes a majority of ${whose}. Spread three replicas over three zones.`;
  }
  return "Each shard has one instance, so losing a zone loses the keys on its shards.";
}
