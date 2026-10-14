import { create } from "zustand";

/** Sizes the person dragged panels to, in pixels, kept across visits. */
const STORAGE_KEY = "archdrill.layout";

export const LIMITS = {
  left: { min: 224, max: 560, initial: 288 },
  right: { min: 280, max: 640, initial: 336 },
  /** The results drawer; its maximum also leaves the canvas some room (see dockLimit). */
  dock: { min: 140, initial: 300 },
} as const;

/** Header plus the least canvas the drawer may leave. */
const RESERVED_ABOVE_DOCK = 220;

/** The tallest the drawer may be in a window of this height. */
export const dockLimit = (windowHeight: number) =>
  Math.max(LIMITS.dock.min, windowHeight - RESERVED_ABOVE_DOCK);

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.min(max, Math.max(min, value)));

interface Stored {
  readonly left: number;
  readonly right: number;
  readonly dock: number;
  /** Traffic moving along the canvas edges. */
  readonly animateTraffic: boolean;
}

const DEFAULTS: Stored = {
  left: LIMITS.left.initial,
  right: LIMITS.right.initial,
  dock: LIMITS.dock.initial,
  animateTraffic: true,
};

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Record<keyof Stored, unknown>>;
    const number = (value: unknown, fallback: number) =>
      typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return {
      left: clamp(number(parsed.left, DEFAULTS.left), LIMITS.left.min, LIMITS.left.max),
      right: clamp(number(parsed.right, DEFAULTS.right), LIMITS.right.min, LIMITS.right.max),
      dock: Math.max(LIMITS.dock.min, number(parsed.dock, DEFAULTS.dock)),
      animateTraffic:
        typeof parsed.animateTraffic === "boolean"
          ? parsed.animateTraffic
          : DEFAULTS.animateTraffic,
    };
  } catch {
    return DEFAULTS;
  }
}

interface LayoutState extends Stored {
  setLeft: (width: number) => void;
  setRight: (width: number) => void;
  setDockHeight: (height: number) => void;
  setAnimateTraffic: (on: boolean) => void;
  /** Remembers the current sizes; called when a drag or key press ends. */
  save: () => void;
  reset: (panel: "left" | "right" | "dock") => void;
}

export const useLayout = create<LayoutState>((set, get) => ({
  ...load(),
  setLeft: (width) => set({ left: clamp(width, LIMITS.left.min, LIMITS.left.max) }),
  setRight: (width) => set({ right: clamp(width, LIMITS.right.min, LIMITS.right.max) }),
  setDockHeight: (height) =>
    set({ dock: clamp(height, LIMITS.dock.min, dockLimit(window.innerHeight)) }),
  setAnimateTraffic: (animateTraffic) => {
    set({ animateTraffic });
    get().save();
  },
  save: () => {
    const { left, right, dock, animateTraffic } = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ left, right, dock, animateTraffic }));
    } catch {
      // Not remembered across visits, but still applied now.
    }
  },
  reset: (panel) => {
    set({ [panel]: DEFAULTS[panel] });
    get().save();
  },
}));
