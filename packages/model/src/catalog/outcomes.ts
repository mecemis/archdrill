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
  miss: "absent",
  notFound: "absent",
  expired: "negative",
  invalid: "negative",
  disabled: "negative",
  conflict: "conflict",
  error: "error",
};

export function outcomeTone(outcome: string): OutcomeTone {
  return TONES[outcome] ?? "negative";
}
