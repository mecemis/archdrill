import { examplesFor } from "@archdrill/content";
import { BookOpen, CircleHelp, ListChecks, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { activePack } from "../../state/content";
import { useOnboarding } from "../../state/onboarding";
import { FOCUS_RING, IconButton } from "../../ui/primitives";
import { exampleCovers, openExample } from "./actions";

const ITEM = `flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted ${FOCUS_RING}`;

/** Help: the getting-started guide, the welcome screen, and example designs to study. */
export function HelpMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const guideOpen = useOnboarding((s) => s.guideOpen);
  const examples = examplesFor(activePack.problem.id);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof PointerEvent && root.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div ref={root} className="relative">
      <IconButton
        aria-label="Help"
        title="Help: the guide, the welcome screen and example designs"
        aria-expanded={open}
        aria-haspopup="menu"
        active={open}
        onClick={() => setOpen(!open)}
      >
        <CircleHelp className="h-4 w-4" />
      </IconButton>
      {open && (
        <div
          role="menu"
          aria-label="Help"
          className="absolute top-full right-0 z-40 mt-2 flex w-80 flex-col gap-0.5 rounded-xl border border-line bg-elevated p-1.5 shadow-pop"
        >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={guideOpen}
            className={ITEM}
            onClick={() => choose(() => useOnboarding.getState().setGuideOpen(!guideOpen))}
          >
            <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-accent-fg" aria-hidden="true" />
            <span className="flex flex-col">
              <span className="font-medium text-fg">
                {guideOpen ? "Hide the getting-started guide" : "Getting-started guide"}
              </span>
              <span className="text-xs text-fg-subtle">
                A checklist from an empty canvas to a score, with pointers.
              </span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            onClick={() => choose(() => useOnboarding.getState().reopenWelcome())}
          >
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent-fg" aria-hidden="true" />
            <span className="flex flex-col">
              <span className="font-medium text-fg">How ArchDrill works</span>
              <span className="text-xs text-fg-subtle">The welcome screen, in three steps.</span>
            </span>
          </button>
          {examples.length > 0 && (
            <>
              <p className="mt-1 border-t border-line px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-fg-subtle uppercase">
                Example designs (spoilers)
              </p>
              {examples.map((example) => (
                <button
                  key={example.id}
                  type="button"
                  role="menuitem"
                  className={ITEM}
                  title={example.description}
                  onClick={() => choose(() => openExample(example))}
                >
                  <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                  <span className="flex flex-col">
                    <span className="font-medium text-fg">{example.title}</span>
                    <span className="text-xs text-fg-subtle">
                      Reference for {exampleCovers(example) || "no scenario"}; replaces your design
                      until you undo.
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
