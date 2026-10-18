import { create } from "zustand";
import { activePack } from "./content";

export type Selection =
  | { readonly type: "component"; readonly id: string }
  | { readonly type: "connection"; readonly id: string }
  | null;

export type Attach =
  | { readonly to: "root" }
  | { readonly to: "outcome"; readonly stepId: string; readonly outcome: string };

/** Where in a flow a step goes: first, or behind outcomes of a step. */
export type CursorPosition =
  | { readonly kind: "root" }
  | { readonly kind: "after"; readonly stepId: string; readonly outcomes: readonly string[] };

/** What a new step does there: go at the position, or in front of another step. */
export type CursorMode =
  | { readonly kind: "append"; readonly at: CursorPosition }
  | { readonly kind: "insert"; readonly at: CursorPosition; readonly before: string };

/** Where the next recorded step goes. `before` inserts in front of an existing step. */
export interface Slot {
  readonly operation: string;
  readonly attach: Attach;
  readonly before?: string;
  /** The whole position, for adding from the canvas; derived from `attach` when absent. */
  readonly mode?: CursorMode;
  /** Who armed it: a picker in the Flow panel, or adding on the canvas. */
  readonly source?: "panel" | "canvas";
}

/** A step to bring into view in the Flow panel, e.g. after clicking its number on the canvas. */
export interface FocusedStep {
  readonly operation: string;
  readonly stepId: string;
  /** Changes on every request, so the same step can be focused twice. */
  readonly at: number;
}

/** Canvas and panel elements to emphasise; everything else is dimmed while active. */
export interface Highlight {
  readonly components: ReadonlySet<string>;
  readonly connections: ReadonlySet<string>;
  readonly steps: ReadonlySet<string>;
  /** Decision points under Decisions. */
  readonly decisions: ReadonlySet<string>;
}

export type ResultsTab = "findings" | "paths" | "load" | "timeline" | "issues" | "compare";
export type LeftTab = "brief" | "estimate" | "palette" | "decisions";
export type RightTab = "flow" | "inspector";
/** How much room the results drawer takes: its header only, a share of the screen, or most of it. */
export type DockSize = "min" | "normal" | "max";

interface UiState {
  readonly scenarioId: string;
  readonly operation: string;
  readonly selection: Selection;
  readonly slot: Slot | null;
  /** Component clicked on the canvas while a slot was armed. */
  readonly canvasTarget: string | null;
  readonly focusedStep: FocusedStep | null;
  /** The flow studio covers the app: a sequence diagram of the operation's flow. */
  readonly studioOpen: boolean;
  /** Lifelines added in the studio to call next, by operation, until a step calls them. */
  readonly studioLifelines: Readonly<Record<string, readonly string[]>>;
  readonly hover: Highlight | null;
  readonly pinned: { readonly key: string; readonly highlight: Highlight } | null;
  readonly resultsTab: ResultsTab;
  /** The open left panel; null when it is collapsed to its rail. */
  readonly leftTab: LeftTab | null;
  readonly rightTab: RightTab;
  readonly rightOpen: boolean;
  readonly dock: DockSize;
  /** The timeline the Timeline tab shows; null for the scenario's first. */
  readonly timelineId: string | null;
  /** A moment of a timeline the canvas shows instead of the selected environment. */
  readonly timelineCursor: { readonly timelineId: string; readonly step: number } | null;
  /** Simulated environment shown on the canvas and in the results; null means the scenario's last (heaviest). */
  readonly environmentId: string | null;
  setScenario: (id: string) => void;
  setEnvironment: (id: string | null) => void;
  setOperation: (id: string) => void;
  select: (selection: Selection) => void;
  armSlot: (slot: Slot | null) => void;
  setCanvasTarget: (componentId: string | null) => void;
  /** Shows a step in the Flow panel: opens the panel on Flow and scrolls to it. */
  focusStep: (operation: string, stepId: string) => void;
  setStudioOpen: (open: boolean) => void;
  addStudioLifeline: (operation: string, componentId: string) => void;
  setHover: (highlight: Highlight | null) => void;
  togglePin: (key: string, highlight: Highlight) => void;
  clearPin: () => void;
  setResultsTab: (tab: ResultsTab) => void;
  /** Opens a left panel; choosing the open one collapses it. */
  toggleLeftTab: (tab: LeftTab) => void;
  openLeftTab: (tab: LeftTab) => void;
  setRightTab: (tab: RightTab) => void;
  setRightOpen: (open: boolean) => void;
  setDock: (dock: DockSize) => void;
  setTimelineId: (timelineId: string) => void;
  setTimelineCursor: (cursor: { timelineId: string; step: number } | null) => void;
}

const firstScenario = activePack.scenarios[0];

export const useUi = create<UiState>((set, get) => ({
  scenarioId: firstScenario?.id ?? "",
  operation: firstScenario?.focusOperations[0] ?? activePack.problem.operations[0]?.id ?? "",
  selection: null,
  slot: null,
  canvasTarget: null,
  focusedStep: null,
  studioOpen: false,
  studioLifelines: {},
  hover: null,
  pinned: null,
  resultsTab: "findings",
  leftTab: "brief",
  rightTab: "flow",
  rightOpen: true,
  dock: "normal",
  timelineId: null,
  timelineCursor: null,
  environmentId: null,
  setScenario: (scenarioId) => {
    const scenario = activePack.scenarios.find((s) => s.id === scenarioId);
    set({
      scenarioId,
      operation: scenario?.focusOperations[0] ?? get().operation,
      slot: null,
      environmentId: null,
      timelineId: null,
      timelineCursor: null,
    });
  },
  setEnvironment: (environmentId) => set({ environmentId }),
  setOperation: (operation) => set({ operation, slot: null, canvasTarget: null }),
  select: (selection) => set({ selection }),
  armSlot: (slot) => set({ slot, canvasTarget: null }),
  setCanvasTarget: (canvasTarget) => set({ canvasTarget }),
  // Nothing stays selected behind the studio, where a key could act on it unseen.
  setStudioOpen: (studioOpen) =>
    set({ studioOpen, slot: null, canvasTarget: null, selection: null }),
  addStudioLifeline: (operation, componentId) =>
    set((state) => ({
      studioLifelines: {
        ...state.studioLifelines,
        [operation]: [...(state.studioLifelines[operation] ?? []), componentId],
      },
    })),
  focusStep: (operation, stepId) =>
    set({
      operation,
      rightTab: "flow",
      rightOpen: true,
      focusedStep: { operation, stepId, at: Date.now() },
    }),
  setHover: (hover) => set({ hover }),
  togglePin: (key, highlight) =>
    set({ pinned: get().pinned?.key === key ? null : { key, highlight } }),
  clearPin: () => set({ pinned: null }),
  setResultsTab: (resultsTab) =>
    // Timelines need the room; other views open a collapsed drawer and keep any other size.
    set({
      resultsTab,
      dock: resultsTab === "timeline" ? "max" : get().dock === "min" ? "normal" : get().dock,
    }),
  toggleLeftTab: (tab) => set({ leftTab: get().leftTab === tab ? null : tab }),
  openLeftTab: (leftTab) => set({ leftTab }),
  setRightTab: (rightTab) => set({ rightTab, rightOpen: true }),
  setRightOpen: (rightOpen) => set({ rightOpen }),
  setDock: (dock) => set({ dock }),
  setTimelineId: (timelineId) => set({ timelineId, timelineCursor: null }),
  setTimelineCursor: (timelineCursor) => set({ timelineCursor }),
}));

export const EMPTY_HIGHLIGHT: Highlight = {
  components: new Set(),
  connections: new Set(),
  steps: new Set(),
  decisions: new Set(),
};
