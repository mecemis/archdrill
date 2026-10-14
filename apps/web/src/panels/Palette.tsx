import type { Flavor, Kind, Position } from "@archdrill/model";
import { useReactFlow } from "@xyflow/react";
import { Search } from "lucide-react";
import { useState } from "react";
import { addComponentFromPalette, PALETTE_MIME } from "../canvas/palette-drop";
import { catalogIndex } from "../state/content";
import { useAttemptStore } from "../state/store";
import { useUi } from "../state/ui-store";
import { CATEGORIES, CATEGORY_ORDER, KindChip, kindCategory } from "../ui/icons";
import { FOCUS_RING, Input, SectionTitle } from "../ui/primitives";

const NODE_HALF_WIDTH = 96;
const NODE_HALF_HEIGHT = 36;
const CELL = { x: 240, y: 110 } as const;
const MAX_RINGS = 8;

/** Grid offsets ordered by ring: the centre first, then each surrounding ring. */
function* gridSpiral(): Generator<Position> {
  yield { x: 0, y: 0 };
  for (let ring = 1; ring <= MAX_RINGS; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) yield { x: dx, y: dy };
      }
    }
  }
}

interface Area {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Cards floating over the canvas (the guide), in canvas coordinates: new nodes stay clear of them. */
function overlayAreas(toFlow: (point: Position) => Position): Area[] {
  return [...document.querySelectorAll("[data-canvas-overlay]")].map((element) => {
    const rect = element.getBoundingClientRect();
    const topLeft = toFlow({ x: rect.left, y: rect.top });
    const bottomRight = toFlow({ x: rect.right, y: rect.bottom });
    return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y };
  });
}

/** First grid cell near the centre of the visible canvas that no node or floating card occupies. */
function freeSpotNearCentre(
  toFlow: (point: Position) => Position,
  taken: readonly Position[],
): Position {
  const rect = document.querySelector(".react-flow")?.getBoundingClientRect();
  const centre = rect
    ? toFlow({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
    : { x: 0, y: 0 };
  const covered = overlayAreas(toFlow);
  const origin = { x: centre.x - NODE_HALF_WIDTH, y: centre.y - NODE_HALF_HEIGHT };
  for (const offset of gridSpiral()) {
    const spot = { x: origin.x + offset.x * CELL.x, y: origin.y + offset.y * CELL.y };
    const free =
      taken.every(
        (p) => Math.abs(p.x - spot.x) >= CELL.x - 20 || Math.abs(p.y - spot.y) >= CELL.y - 15,
      ) &&
      covered.every(
        (area) =>
          spot.x + 2 * NODE_HALF_WIDTH < area.left ||
          spot.x > area.right ||
          spot.y + 2 * NODE_HALF_HEIGHT < area.top ||
          spot.y > area.bottom,
      );
    if (free) return spot;
  }
  return origin;
}

/** Lower-case text a palette entry is found by. */
function searchText(kind: Kind, flavor: Flavor): string {
  return [kind.label, kind.description, flavor.label, flavor.description, ...kind.capabilities]
    .join(" ")
    .toLowerCase();
}

export function Palette() {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const layout = useAttemptStore((s) => s.attempt.layout);
  const { screenToFlowPosition } = useReactFlow();
  const [query, setQuery] = useState("");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    entries: catalogIndex.catalog.kinds
      .filter((kind) => kindCategory(kind.id) === category)
      .flatMap((kind) =>
        kind.flavors
          .filter((flavor) => {
            const text = searchText(kind, flavor);
            return terms.every((t) => text.includes(t));
          })
          .map((flavor) => ({ kind, flavor })),
      ),
  })).filter((group) => group.entries.length > 0);

  return (
    <div className="flex flex-col gap-4 p-3" data-tour="palette">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-fg-subtle"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search components"
          aria-label="Search components"
          className="w-full pl-8"
        />
      </div>
      <p className="-mt-2 px-1 text-xs text-fg-subtle">Drag onto the canvas, or click to add.</p>
      {groups.length === 0 && (
        <p className="px-1 text-sm text-fg-subtle">Nothing matches "{query}".</p>
      )}
      {groups.map(({ category, entries }) => (
        <section key={category} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 px-1">
            <span
              className={`h-1.5 w-1.5 rounded-full ${CATEGORIES[category].solid}`}
              aria-hidden="true"
            />
            <SectionTitle>{CATEGORIES[category].label}</SectionTitle>
          </div>
          {entries.map(({ kind, flavor }) => (
            <button
              key={`${kind.id}/${flavor.id}`}
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(
                  PALETTE_MIME,
                  JSON.stringify({ kind: kind.id, flavor: flavor.id }),
                );
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => {
                const id = addComponentFromPalette(
                  { kind: kind.id, flavor: flavor.id },
                  freeSpotNearCentre(screenToFlowPosition, Object.values(layout)),
                  dispatch,
                );
                if (id) useUi.getState().select({ type: "component", id });
              }}
              title={flavor.description}
              aria-label={flavor.label}
              data-tour={kind.id === "service" ? "palette-service" : undefined}
              className={`group flex cursor-grab items-start gap-2.5 rounded-xl border border-line bg-surface p-2 text-left shadow-card transition-colors hover:border-accent-line hover:bg-accent-soft active:cursor-grabbing ${FOCUS_RING}`}
            >
              <KindChip kind={kind.id} />
              <span className="flex min-w-0 flex-col">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate text-[13px] font-semibold text-fg">{flavor.label}</span>
                  <span className="truncate text-[11px] text-fg-subtle">{kind.label}</span>
                </span>
                <span className="line-clamp-2 text-xs text-fg-muted">{flavor.description}</span>
              </span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
