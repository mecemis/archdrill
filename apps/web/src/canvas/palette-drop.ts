import type { Position } from "@archdrill/model";
import type { AttemptState } from "../state/attempt-store";
import { catalogIndex } from "../state/content";

export const PALETTE_MIME = "application/x-archdrill-component";

export interface PaletteItem {
  readonly kind: string;
  readonly flavor: string;
}

export function parsePaletteData(raw: string): PaletteItem | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      "flavor" in value &&
      typeof value.kind === "string" &&
      typeof value.flavor === "string"
    ) {
      return { kind: value.kind, flavor: value.flavor };
    }
  } catch {
    // Not our payload (e.g. a file dragged from the desktop).
  }
  return null;
}

/** Adds a catalog flavor with its default size and a readable label. */
export function addComponentFromPalette(
  item: PaletteItem,
  position: Position,
  dispatch: AttemptState["dispatch"],
): string | undefined {
  const flavor = catalogIndex.flavor(item.kind, item.flavor);
  if (!flavor) return undefined;
  return dispatch("addComponent", {
    kind: item.kind,
    flavor: item.flavor,
    label: flavor.label,
    ...(flavor.defaultSize === undefined ? {} : { size: flavor.defaultSize }),
    position,
  });
}
