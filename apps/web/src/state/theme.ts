import { create } from "zustand";

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/** Shared with public/theme.js, which applies the theme before first paint. */
const STORAGE_KEY = "archdrill.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches
    ? "dark"
    : "light";
}

const resolve = (choice: ThemeChoice): Theme => (choice === "system" ? systemTheme() : choice);

function apply(theme: Theme): void {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
}

interface ThemeState {
  /** What the person picked. */
  readonly choice: ThemeChoice;
  /** What is shown: the system's theme when the choice is "system". */
  readonly theme: Theme;
  setChoice: (choice: ThemeChoice) => void;
}

const initialChoice = readChoice();

export const useTheme = create<ThemeState>((set) => ({
  choice: initialChoice,
  theme: resolve(initialChoice),
  setChoice(choice) {
    try {
      if (choice === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Not remembered across visits, but still applied now.
    }
    const theme = resolve(choice);
    apply(theme);
    set({ choice, theme });
  },
}));

/** The next choice when cycling: system, then light, then dark. */
export const NEXT_CHOICE: Readonly<Record<ThemeChoice, ThemeChoice>> = {
  system: "light",
  light: "dark",
  dark: "system",
};

apply(useTheme.getState().theme);

// Follow the system while the choice is "system".
if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia(DARK_QUERY).addEventListener?.("change", () => {
    const { choice } = useTheme.getState();
    if (choice !== "system") return;
    const theme = systemTheme();
    apply(theme);
    useTheme.setState({ theme });
  });
}
