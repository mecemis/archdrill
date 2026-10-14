import { type KeyboardEvent, type PointerEvent, useRef } from "react";

/** Pixels one arrow key moves a handle; Shift moves four times as far. */
const KEY_STEP = 16;

/**
 * A draggable edge that resizes a panel, also usable from the keyboard
 * (arrow keys) and reset by a double click.
 *
 * `grow` says which way the size increases: +1 when dragging right or down
 * makes the panel bigger, -1 when dragging left or up does.
 */
export function ResizeHandle({
  axis,
  grow,
  value,
  min,
  max,
  label,
  onResize,
  onEnd,
  onReset,
  className = "",
}: {
  readonly axis: "x" | "y";
  readonly grow: 1 | -1;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly label: string;
  readonly onResize: (size: number) => void;
  readonly onEnd: () => void;
  readonly onReset: () => void;
  readonly className?: string;
}) {
  const drag = useRef<{ readonly from: number; readonly size: number } | null>(null);
  const position = (event: PointerEvent) => (axis === "x" ? event.clientX : event.clientY);

  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    onEnd();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const forward = axis === "x" ? "ArrowRight" : "ArrowDown";
    const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
    if (event.key !== forward && event.key !== back) return;
    event.preventDefault();
    const step = (event.shiftKey ? 4 : 1) * KEY_STEP * (event.key === forward ? 1 : -1);
    onResize(value + grow * step);
    onEnd();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be focused and dragged; a separator with a value is the ARIA pattern for a splitter
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} (drag, or double-click to reset)`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { from: position(event), size: value };
        document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        onResize(drag.current.size + grow * (position(event) - drag.current.from));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={`group absolute z-20 flex touch-none items-center justify-center outline-none ${
        axis === "x" ? "inset-y-0 w-2 cursor-col-resize" : "inset-x-0 h-2 cursor-row-resize"
      } ${className}`}
    >
      <span
        aria-hidden="true"
        className={`rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-100 group-active:opacity-100 ${
          axis === "x" ? "h-full w-0.5" : "h-0.5 w-full"
        }`}
      />
    </div>
  );
}
