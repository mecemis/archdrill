import { z } from "zod";
import { IdSchema } from "../catalog/schema";

/** What an estimate measures: a count, a count per second, bytes, or bytes per second. */
export const QuantityKindSchema = z.enum(["count", "rate", "bytes", "byte-rate"]);
export type QuantityKind = z.infer<typeof QuantityKindSchema>;

/** A back-of-envelope question with its answer, in base units (items, bytes, seconds). */
export const EstimateSchema = z.object({
  id: IdSchema,
  question: z.string().min(1),
  kind: QuantityKindSchema,
  answer: z.number().positive(),
  /** Within this factor of the answer, either way, an estimate is close enough. */
  tolerance: z.number().gt(1).default(2),
  /** How the answer follows from the brief, shown once the candidate has answered. */
  derivation: z.string().min(1),
});
export type Estimate = z.infer<typeof EstimateSchema>;

const COUNT_SCALES: Readonly<Record<string, number>> = {
  "": 1,
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  t: 1e12,
  trillion: 1e12,
};

const BYTE_SCALES: Readonly<Record<string, number>> = {
  "": 1,
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
};

const isBytes = (kind: QuantityKind) => kind === "bytes" || kind === "byte-rate";

/**
 * Reads a quantity the way people write estimates: `86.4M`, `158 billion`,
 * `79 TB`, `3.5e12`, `3.5 × 10^12`, `60 MB/s`. Returns null when the text is
 * not a positive quantity of that kind.
 */
export function parseQuantity(text: string, kind: QuantityKind): number | null {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/\s*(?:\/\s*s(?:ec(?:ond)?)?|per\s+second|a\s+second|rps|qps)$/, "")
    // A bare power of ten: 10^12 is 1 × 10^12.
    .replace(/^10\s*\^/, "1 x 10^");
  const match = cleaned.match(
    /^(\d+(?:\.\d+)?|\.\d+)(?:e([+-]?\d+))?(?:\s*[x×*]\s*10\s*\^\s*([+-]?\d+))?\s*([a-z]*)$/,
  );
  if (!match) return null;
  const [, digits, exponent, power, unit = ""] = match;
  const scale = (isBytes(kind) ? BYTE_SCALES : COUNT_SCALES)[unit];
  if (scale === undefined) return null;
  const value = Number(digits) * 10 ** Number(exponent ?? 0) * 10 ** Number(power ?? 0) * scale;
  return Number.isFinite(value) && value > 0 ? value : null;
}

const COUNT_UNITS = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
] as const;

const BYTE_UNITS = [
  [1e15, "PB"],
  [1e12, "TB"],
  [1e9, "GB"],
  [1e6, "MB"],
  [1e3, "KB"],
] as const;

/** Three significant digits with the largest unit that fits: `86.4 M`, `79.0 TB`, `60.0 MB/s`. */
export function formatQuantity(value: number, kind: QuantityKind): string {
  const units = isBytes(kind) ? BYTE_UNITS : COUNT_UNITS;
  const [scale, unit] = units.find(([s]) => value >= s) ?? [1, isBytes(kind) ? "bytes" : ""];
  const scaled = value / scale;
  const shown = scaled >= 1000 ? Math.round(scaled).toLocaleString("en-US") : scaled.toPrecision(3);
  const perSecond = kind === "rate" || kind === "byte-rate" ? "/s" : "";
  return `${shown}${unit ? ` ${unit}` : ""}${perSecond}`;
}
