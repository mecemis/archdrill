import type { Position } from "@archdrill/model";
import { useReactFlow } from "@xyflow/react";
import { addComponentFromPalette, PALETTE_MIME } from "../canvas/palette-drop";
import { catalogIndex } from "../state/content";
import { useAttemptStore } from "../state/store";
import { useUi } from "../state/ui-store";
import { KindIcon } from "../ui/icons";
import { SectionTitle } from "../ui/primitives";

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

/** First grid cell near the centre of the visible canvas that no node occupies. */
function freeSpotNearCentre(
  toFlow: (point: Position) => Position,
  taken: readonly Position[],
): Position {
  const rect = document.querySelector(".react-flow")?.getBoundingClientRect();
  const centre = rect
    ? toFlow({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
    : { x: 0, y: 0 };
  const origin = { x: centre.x - NODE_HALF_WIDTH, y: centre.y - NODE_HALF_HEIGHT };
  for (const offset of gridSpiral()) {
    const spot = { x: origin.x + offset.x * CELL.x, y: origin.y + offset.y * CELL.y };
    const free = taken.every(
      (p) => Math.abs(p.x - spot.x) >= CELL.x - 20 || Math.abs(p.y - spot.y) >= CELL.y - 15,
    );
    if (free) return spot;
  }
  return origin;
}

export function Palette() {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const layout = useAttemptStore((s) => s.attempt.layout);
  const { screenToFlowPosition } = useReactFlow();

  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-xs text-zinc-500">Drag onto the canvas, or click to add.</p>
      {catalogIndex.catalog.kinds.map((kind) => (
        <section key={kind.id} className="flex flex-col gap-1.5">
          <SectionTitle>{kind.label}</SectionTitle>
          {kind.flavors.map((flavor) => (
            <button
              key={flavor.id}
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
              className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-left text-sm text-zinc-800 hover:border-sky-400 hover:bg-sky-50"
            >
              <KindIcon kind={kind.id} className="h-4 w-4 shrink-0 text-zinc-500" />
              {flavor.label}
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
