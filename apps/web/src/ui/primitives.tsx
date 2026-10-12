import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Readonly<Record<Variant, string>> = {
  primary: "bg-sky-700 text-white hover:bg-sky-800 disabled:bg-sky-300",
  secondary:
    "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 disabled:text-zinc-400",
  ghost: "text-zinc-700 hover:bg-zinc-100 disabled:text-zinc-300",
  danger: "border border-rose-300 bg-white text-rose-700 hover:bg-rose-50",
};

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-sky-600 disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as a child, which wraps it in the label
    <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
      {label}
      {children}
    </label>
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus-visible:outline-2 focus-visible:outline-sky-600"
      {...props}
    />
  );
}

export function SectionTitle({ children }: { readonly children: ReactNode }) {
  return (
    <h3 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">{children}</h3>
  );
}

export interface TabOption<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly count?: number;
}

export function Tabs<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  readonly options: readonly TabOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={option.id === value}
          onClick={() => onChange(option.id)}
          className={`rounded-md px-2.5 py-1 text-sm font-medium ${
            option.id === value ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
          }`}
        >
          {option.label}
          {option.count !== undefined && (
            <span className="ml-1.5 rounded-full bg-zinc-200 px-1.5 text-xs text-zinc-800">
              {option.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
