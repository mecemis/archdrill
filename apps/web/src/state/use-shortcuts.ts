import { useEffect } from "react";
import { useAttemptStore } from "./store";
import { useUi } from "./ui-store";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
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
        ui.armSlot(null);
        ui.clearPin();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
