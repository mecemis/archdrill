import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { type Choice, choicesAt, matching } from "../panels/flow/command";
import { addAtSlot, addPatternAtSlot } from "../panels/flow/cursor";
import { operationFacts } from "../panels/flow/FlowSequence";
import type { EditContext } from "../panels/flow/flow-edits";
import { operationEntity } from "../panels/flow/pick";
import { useToasts } from "../state/toasts";
import { type CursorMode, type Slot, useUi } from "../state/ui-store";
import { FOCUS_RING } from "../ui/primitives";

/** At most this many matches show above the line. */
const SHOWN = 8;

/**
 * The command line in the canvas's bar: type what a step does, and Enter adds
 * the highlighted match where the bar says, then carries on behind it, so a
 * path can be typed step by step. "/" anywhere opens it. Escape clears what
 * was typed, then stops adding.
 */
export function CommandLine({
  slot,
  ctx,
  mode,
}: {
  readonly slot: Slot;
  readonly ctx: EditContext;
  readonly mode: CursorMode;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useId();

  const requested = useUi((s) => s.commandLineRequested);
  useEffect(() => {
    if (!requested) return;
    input.current?.focus({ preventScroll: true });
    useUi.getState().requestCommandLine(false);
  }, [requested]);

  const operation = ctx.flow.operation;
  const facts = useMemo(() => operationFacts(operation), [operation]);
  const modeKey = JSON.stringify(mode);
  // biome-ignore lint/correctness/useExhaustiveDependencies: modeKey stands for the mode
  const choices = useMemo(
    () => choicesAt(ctx, mode, operationEntity(operation), facts),
    [ctx, modeKey, operation, facts],
  );
  const shown = matching(choices, query).slice(0, SHOWN);
  const highlighted = Math.min(active, Math.max(0, shown.length - 1));
  const expanded = open && shown.length > 0;

  const add = (choice: Choice) => {
    const added =
      choice.add.kind === "step"
        ? addAtSlot(slot, choice.add.step)
        : addPatternAtSlot(slot, choice.add.pattern);
    if (!added) {
      useToasts
        .getState()
        .notify("That cannot go here. Choose another, or move the place with the arrows.", "error");
      return;
    }
    setQuery("");
    setActive(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (shown.length === 0) return;
      const by = event.key === "ArrowDown" ? 1 : -1;
      setActive((highlighted + by + shown.length) % shown.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = shown[highlighted];
      if (choice) add(choice);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (query !== "") {
        setQuery("");
        setActive(0);
      } else {
        useUi.getState().armSlot(null);
      }
    }
  };

  // The matches open above the whole bar (the nearest positioned box), not over its first line.
  return (
    <div>
      {expanded && (
        <div
          id={list}
          role="listbox"
          aria-label="Steps that match"
          className="absolute bottom-full left-0 mb-2 flex max-h-72 w-full flex-col overflow-y-auto rounded-xl border border-accent-line bg-elevated p-1 shadow-pop"
          data-testid="command-matches"
        >
          {shown.map((choice, i) => (
            // The line keeps focus: options are chosen with the arrows and Enter, or a click.
            // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox's input handles the keys
            <div
              key={choice.key}
              id={`${list}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === highlighted}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => add(choice)}
              className={`flex cursor-pointer items-baseline gap-2 rounded-lg px-2 py-1.5 text-[13px] ${
                i === highlighted ? "bg-accent-soft text-accent-fg" : "text-fg"
              }`}
            >
              <span className="min-w-0 flex-1">{choice.label}</span>
              <span className="shrink-0 text-[11px] text-fg-subtle">{choice.group}</span>
            </div>
          ))}
        </div>
      )}
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-label="Type a step"
        aria-expanded={expanded}
        aria-controls={list}
        aria-autocomplete="list"
        aria-activedescendant={expanded ? `${list}-${highlighted}` : undefined}
        placeholder="Type a step: read, publish, 404… ( / )"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className={`h-8 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-fg placeholder:text-fg-faint ${FOCUS_RING}`}
      />
    </div>
  );
}
