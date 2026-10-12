/** 1234 → "1.2K", 92000 → "92K", 1.5e6 → "1.5M". */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return trim(value);
}

function trim(value: number): string {
  return Math.abs(value) >= 100
    ? Math.round(value).toString()
    : value.toFixed(1).replace(/\.0$/, "");
}

export function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function milliseconds(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}

export function usd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** Tailwind classes for a utilisation level: calm below 60%, warning to 80%, danger above. */
export function utilizationTone(value: number): string {
  if (value > 0.8) return "bg-rose-500";
  if (value > 0.6) return "bg-amber-500";
  return "bg-emerald-500";
}
