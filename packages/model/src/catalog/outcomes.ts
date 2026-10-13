/**
 * Visual and semantic tone of an outcome name, shared by every action and
 * logic step. The UI pairs each tone with an icon and line pattern so colour
 * is never the only signal.
 */
export type OutcomeTone = "positive" | "absent" | "negative" | "conflict" | "error";

const TONES: Readonly<Record<string, OutcomeTone>> = {
  hit: "positive",
  ok: "positive",
  found: "positive",
  valid: "positive",
  active: "positive",
  generated: "positive",
  custom: "positive",
  clean: "positive",
  under: "positive",
  miss: "absent",
  notFound: "absent",
  negativeHit: "absent",
  expired: "negative",
  invalid: "negative",
  disabled: "negative",
  conflict: "conflict",
  error: "error",
};

export function outcomeTone(outcome: string): OutcomeTone {
  return TONES[outcome] ?? "negative";
}
