import { useEffect, useState } from "react";
import { useOnboarding } from "../state/onboarding";

/** How long a spotlight stays, unless the person clicks first. */
const SPOTLIGHT_MS = 7000;
/** Room around the highlighted control. */
const PADDING = 6;
/** Distance between the control and its instruction. */
const GAP = 10;

interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

const same = (a: Box | null, b: Box | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height);

/**
 * Rings the control the guide points at and shows its instruction. It
 * follows the control while panels open or the canvas moves, and goes away on
 * the next click or after a few seconds.
 */
export function Spotlight() {
  const target = useOnboarding((s) => s.spotlight);
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    if (!target) {
      setBox(null);
      return;
    }
    const clear = () => useOnboarding.getState().clearSpotlight();
    const started = performance.now();
    let frame = 0;
    let scrolled = false;
    const measure = () => {
      const element = document.querySelector(target.selector);
      // Bring a control in a scrolled panel into view once it exists.
      if (element && !scrolled) {
        element.scrollIntoView({ block: "nearest", inline: "nearest" });
        scrolled = true;
      }
      const rect = element?.getBoundingClientRect();
      // Only the part on screen: a long list must not ring the whole page.
      const top = rect ? Math.max(rect.top, 0) : 0;
      const left = rect ? Math.max(rect.left, 0) : 0;
      const bottom = rect ? Math.min(rect.bottom, window.innerHeight) : 0;
      const right = rect ? Math.min(rect.right, window.innerWidth) : 0;
      const next =
        rect && right > left && bottom > top
          ? { top, left, width: right - left, height: bottom - top }
          : null;
      setBox((current) => (same(current, next) ? current : next));
      if (performance.now() - started < SPOTLIGHT_MS) frame = requestAnimationFrame(measure);
      else clear();
    };
    frame = requestAnimationFrame(measure);
    window.addEventListener("pointerdown", clear, { capture: true });
    window.addEventListener("keydown", clear, { capture: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", clear, { capture: true });
      window.removeEventListener("keydown", clear, { capture: true });
    };
  }, [target]);

  if (!target || !box) return null;
  const below = box.top + box.height + GAP + 80 < window.innerHeight;
  return (
    <div className="pointer-events-none fixed inset-0 z-50" aria-live="polite">
      <div
        className="spotlight-ring absolute rounded-xl border-2 border-accent"
        style={{
          top: box.top - PADDING,
          left: box.left - PADDING,
          width: box.width + 2 * PADDING,
          height: box.height + 2 * PADDING,
        }}
      />
      <p
        className="absolute max-w-xs rounded-lg bg-inverse px-3 py-2 text-sm text-on-inverse shadow-pop"
        style={{
          left: Math.max(8, Math.min(box.left, window.innerWidth - 328)),
          ...(below
            ? { top: box.top + box.height + PADDING + GAP }
            : { bottom: window.innerHeight - box.top + PADDING + GAP }),
        }}
        role="status"
      >
        {target.text}
      </p>
    </div>
  );
}
