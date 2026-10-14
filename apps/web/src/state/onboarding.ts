import { create } from "zustand";

/** Set once the welcome screen has been seen, so it shows only on a first visit. */
const WELCOMED_KEY = "archdrill.welcomed";
/** Whether the getting-started guide is open, across visits. */
const GUIDE_KEY = "archdrill.guide";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered across visits, but still applied now.
  }
}

/** A control the guide points at, with a short instruction next to it. */
export interface SpotlightTarget {
  readonly selector: string;
  readonly text: string;
}

interface OnboardingState {
  readonly welcomed: boolean;
  readonly guideOpen: boolean;
  readonly spotlight: SpotlightTarget | null;
  finishWelcome: () => void;
  reopenWelcome: () => void;
  setGuideOpen: (open: boolean) => void;
  showSpotlight: (target: SpotlightTarget) => void;
  clearSpotlight: () => void;
}

export const useOnboarding = create<OnboardingState>((set) => ({
  welcomed: read(WELCOMED_KEY) === "1",
  guideOpen: read(GUIDE_KEY) === "open",
  spotlight: null,
  finishWelcome: () => {
    write(WELCOMED_KEY, "1");
    set({ welcomed: true });
  },
  reopenWelcome: () => set({ welcomed: false }),
  setGuideOpen: (guideOpen) => {
    write(GUIDE_KEY, guideOpen ? "open" : "closed");
    set({ guideOpen, ...(guideOpen ? {} : { spotlight: null }) });
  },
  showSpotlight: (spotlight) => set({ spotlight }),
  clearSpotlight: () => set({ spotlight: null }),
}));
