import { useEffect } from "react";
import { useAttemptStore } from "./store";
import { useUi } from "./ui-store";

/** Inputs that take no text, so a focused one should not swallow undo. */
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "file"]);

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return target.isContentEditable || ["TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Undo/redo and escape, ignored while the user is typing in a form field. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        const { undo, redo } = useAttemptStore.getState();
        if (event.shiftKey) redo();
        else undo();
      }
      if (event.key === "Escape") {
        const ui = useUi.getState();
        // A step menu open on the canvas closes first; the next Escape stops adding.
        if (ui.canvasTarget) return ui.setCanvasTarget(null);
        ui.armSlot(null);
        ui.clearPin();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
