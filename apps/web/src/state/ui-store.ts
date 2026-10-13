import { create } from "zustand";
import { activePack } from "./content";

export type Selection =
  | { readonly type: "component"; readonly id: string }
  | { readonly type: "connection"; readonly id: string }
  | null;

export type Attach =
  | { readonly to: "root" }
  | { readonly to: "outcome"; readonly stepId: string; readonly outcome: string };

/** Where the next recorded step goes. `before` inserts in front of an existing step. */
export interface Slot {
  readonly operation: string;
  readonly attach: Attach;
  readonly before?: string;
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
export type RightTab = "flow" | "inspector" | "decisions";

interface UiState {
  readonly scenarioId: string;
  readonly operation: string;
  readonly selection: Selection;
  readonly slot: Slot | null;
  /** Component clicked on the canvas while a slot was armed. */
  readonly canvasTarget: string | null;
  readonly hover: Highlight | null;
  readonly pinned: { readonly key: string; readonly highlight: Highlight } | null;
  readonly resultsTab: ResultsTab;
  readonly rightTab: RightTab;
  /** Simulated environment shown on the canvas and in the results; null means the scenario's last (heaviest). */
  readonly environmentId: string | null;
  setScenario: (id: string) => void;
  setEnvironment: (id: string | null) => void;
  setOperation: (id: string) => void;
  select: (selection: Selection) => void;
  armSlot: (slot: Slot | null) => void;
  setCanvasTarget: (componentId: string | null) => void;
  setHover: (highlight: Highlight | null) => void;
  togglePin: (key: string, highlight: Highlight) => void;
  clearPin: () => void;
  setResultsTab: (tab: ResultsTab) => void;
  setRightTab: (tab: RightTab) => void;
}

const firstScenario = activePack.scenarios[0];

export const useUi = create<UiState>((set, get) => ({
  scenarioId: firstScenario?.id ?? "",
  operation: firstScenario?.focusOperations[0] ?? activePack.problem.operations[0]?.id ?? "",
  selection: null,
  slot: null,
  canvasTarget: null,
  hover: null,
  pinned: null,
  resultsTab: "findings",
  rightTab: "flow",
  environmentId: null,
  setScenario: (scenarioId) => {
    const scenario = activePack.scenarios.find((s) => s.id === scenarioId);
    set({
      scenarioId,
      operation: scenario?.focusOperations[0] ?? get().operation,
      slot: null,
      environmentId: null,
    });
  },
  setEnvironment: (environmentId) => set({ environmentId }),
  setOperation: (operation) => set({ operation, slot: null, canvasTarget: null }),
  select: (selection) => set({ selection }),
  armSlot: (slot) => set({ slot, canvasTarget: null }),
  setCanvasTarget: (canvasTarget) => set({ canvasTarget }),
  setHover: (hover) => set({ hover }),
  togglePin: (key, highlight) =>
    set({ pinned: get().pinned?.key === key ? null : { key, highlight } }),
  clearPin: () => set({ pinned: null }),
  setResultsTab: (resultsTab) => set({ resultsTab }),
  setRightTab: (rightTab) => set({ rightTab }),
}));

export const EMPTY_HIGHLIGHT: Highlight = {
  components: new Set(),
  connections: new Set(),
  steps: new Set(),
  decisions: new Set(),
};
