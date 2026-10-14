import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * A button that opens a small panel next to it. The panel closes on Escape,
 * on a click outside, or when its content calls `close`.
 */
export function Popover({
  trigger,
  children,
  align = "start",
  label,
}: {
  readonly trigger: (props: { readonly open: boolean; readonly toggle: () => void }) => ReactNode;
  readonly children: (close: () => void) => ReactNode;
  readonly align?: "start" | "end";
  /** Names the panel for assistive technology. */
  readonly label: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={root} className="relative inline-flex">
      {trigger({ open, toggle: () => setOpen(!open) })}
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={`absolute top-full z-30 mt-1 flex w-64 flex-col gap-1 rounded-xl border border-line bg-elevated p-1.5 shadow-pop ${
            align === "end" ? "right-0" : "left-0"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  );
}

/** A row in a popover menu. */
export function MenuItem({
  onClick,
  children,
  tone = "default",
}: {
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] focus-visible:outline-2 focus-visible:outline-accent ${
        tone === "danger" ? "text-bad-fg hover:bg-bad-soft" : "text-fg hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}

export function MenuLabel({ children }: { readonly children: ReactNode }) {
  return (
    <p className="px-2.5 pt-1 text-[11px] font-semibold tracking-[0.06em] text-fg-subtle uppercase">
      {children}
    </p>
  );
}
