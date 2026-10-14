import { ChevronDown } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Readonly<Record<Variant, string>> = {
  primary:
    "bg-accent text-on-accent shadow-card hover:bg-accent-strong disabled:opacity-45 disabled:shadow-none",
  secondary:
    "border border-line bg-surface text-fg shadow-card hover:border-line-strong hover:bg-sunken disabled:text-fg-faint disabled:shadow-none",
  ghost:
    "text-fg-muted hover:bg-muted hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent",
  danger: "border border-bad-line bg-bad-soft text-bad-fg hover:border-bad",
};

const SIZES: Readonly<Record<Size, string>> = {
  sm: "h-7 gap-1 rounded-md px-2 text-xs",
  md: "h-8 gap-1.5 rounded-lg px-2.5 text-sm",
};

/** Focus ring shared by every interactive element. */
export const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: Variant;
  readonly size?: Size;
}) {
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed ${FOCUS_RING} ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

/** A square button holding only an icon; it needs an aria-label. */
export function IconButton({
  className = "",
  active = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly active?: boolean }) {
  return (
    <button
      type="button"
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-fg-faint disabled:hover:bg-transparent ${FOCUS_RING} ${
        active ? "bg-accent-soft text-accent-fg" : "text-fg-subtle hover:bg-muted hover:text-fg"
      } ${className}`}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as a child, which wraps it in the label
    <label className="flex flex-col gap-1.5 text-xs font-medium text-fg-muted">
      {label}
      {children}
      {hint && <span className="font-normal text-fg-subtle">{hint}</span>}
    </label>
  );
}

/** Classes for text and number inputs, for the places that render their own. */
export const INPUT_CLASS = `h-8 rounded-lg border border-line bg-surface px-2.5 text-sm text-fg shadow-card placeholder:text-fg-faint hover:border-line-strong disabled:bg-sunken disabled:text-fg-subtle ${FOCUS_RING}`;

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${INPUT_CLASS} ${className}`} {...props} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`relative inline-flex min-w-0 ${className}`}>
      <select
        className={`${INPUT_CLASS} w-full min-w-0 cursor-pointer appearance-none pr-8`}
        {...props}
      />
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2 h-4 w-4 -translate-y-1/2 text-fg-subtle"
        aria-hidden="true"
      />
    </span>
  );
}

export function SectionTitle({ children }: { readonly children: ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold tracking-[0.06em] text-fg-subtle uppercase">
      {children}
    </h3>
  );
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";

const TONES: Readonly<Record<Tone, string>> = {
  neutral: "bg-muted text-fg-muted",
  accent: "bg-accent-soft text-accent-fg",
  ok: "bg-ok-soft text-ok-fg",
  warn: "bg-warn-soft text-warn-fg",
  bad: "bg-bad-soft text-bad-fg",
  info: "bg-info-soft text-info-fg",
};

export function Badge({
  tone = "neutral",
  className = "",
  children,
}: {
  readonly tone?: Tone;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[11px] font-medium whitespace-nowrap tabular-nums ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export interface TabOption<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly count?: number;
}

/** A segmented control; each segment is a tab. */
export function Tabs<T extends string>({
  options,
  value,
  onChange,
  label,
  className = "",
}: {
  readonly options: readonly TabOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={`inline-flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5 ${className}`}
    >
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.id)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors ${FOCUS_RING} ${
              selected ? "bg-surface text-fg shadow-card" : "text-fg-subtle hover:text-fg"
            }`}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                className={`min-w-5 rounded-full px-1.5 text-center text-[11px] tabular-nums ${
                  selected ? "bg-accent-soft text-accent-fg" : "bg-track text-fg-muted"
                }`}
              >
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** A keyboard key, for shortcut hints. */
export function Kbd({ children }: { readonly children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-sunken px-1 font-mono text-[10px] text-fg-subtle">
      {children}
    </kbd>
  );
}
