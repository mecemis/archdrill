import { type EstimateResult, evaluateEstimates, SPOT_ON_FACTOR } from "@archdrill/evaluator";
import { formatQuantity, parseQuantity } from "@archdrill/model";
import { type FormEvent, useEffect, useState } from "react";
import { activePack } from "../state/content";
import { useAttemptStore } from "../state/store";
import { Prose } from "../ui/Prose";
import { Button, SectionTitle } from "../ui/primitives";

const BAND_STYLE = {
  "spot-on": "bg-emerald-100 text-emerald-900",
  close: "bg-amber-100 text-amber-900",
  off: "bg-rose-100 text-rose-900",
} as const;

const percent = (factor: number) => `${Math.round((factor - 1) * 100)}%`;

/** "Spot on", "Close: 1.6× too high", "Off: 12× too low". */
function verdict(result: EstimateResult): string {
  if (result.band === null || result.ratio === null) return "";
  if (result.band === "spot-on") return "Spot on";
  const factor = Math.max(result.ratio, 1 / result.ratio);
  const how = `${factor >= 10 ? Math.round(factor) : factor.toFixed(1)}× too ${result.ratio > 1 ? "high" : "low"}`;
  return `${result.band === "close" ? "Close" : "Off"}: ${how}`;
}

/**
 * The estimation gym: back-of-envelope questions about the problem's scale,
 * answered the way one would on a whiteboard and checked against tolerance
 * bands. Answers are part of the design, so they are saved and exported.
 */
export function EstimatePanel() {
  const attempt = useAttemptStore((s) => s.attempt);
  const results = evaluateEstimates(attempt, activePack.problem);
  if (results.length === 0) {
    return <p className="p-4 text-sm text-zinc-500">This problem has no estimates yet.</p>;
  }
  const answered = results.filter((r) => r.value !== null);
  const spotOn = answered.filter((r) => r.band === "spot-on").length;
  const tolerance = activePack.problem.estimates[0]?.tolerance ?? 2;
  return (
    <div className="flex flex-col gap-4 p-4 text-sm text-zinc-800">
      <section className="flex flex-col gap-1">
        <SectionTitle>Estimate</SectionTitle>
        <p className="text-zinc-700">
          Size the problem before you design it. Write numbers the way you would on a whiteboard:
          86M, 3.5e12, 79 TB, 60 MB/s. Within {percent(SPOT_ON_FACTOR)} is spot on; within{" "}
          {tolerance}× is close.
        </p>
        <p className="text-xs text-zinc-500" data-testid="estimate-summary">
          {answered.length} of {results.length} answered · {spotOn} spot on
        </p>
      </section>
      <ol className="flex flex-col gap-3">
        {results.map((result) => (
          <EstimateCard key={result.estimate.id} result={result} />
        ))}
      </ol>
    </div>
  );
}

function EstimateCard({ result }: { readonly result: EstimateResult }) {
  const dispatch = useAttemptStore((s) => s.dispatch);
  const { estimate, value } = result;
  const [text, setText] = useState(value === null ? "" : formatQuantity(value, estimate.kind));
  const [revealed, setRevealed] = useState(false);
  // Undo, import or reset change the stored answer; show what is stored.
  useEffect(() => {
    setText(value === null ? "" : formatQuantity(value, estimate.kind));
  }, [value, estimate.kind]);
  const parsed = parseQuantity(text, estimate.kind);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() === "") dispatch("setEstimate", { estimate: estimate.id, value: null });
    else if (parsed !== null) dispatch("setEstimate", { estimate: estimate.id, value: parsed });
  };
  const inputId = `estimate-${estimate.id}`;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-white p-3">
      <label htmlFor={inputId} className="font-medium text-zinc-900">
        {estimate.question}
      </label>
      <form onSubmit={submit} className="flex items-center gap-2">
        <input
          id={inputId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. 86M"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
        />
        <Button type="submit" disabled={text.trim() !== "" && parsed === null}>
          Check
        </Button>
      </form>
      {text.trim() !== "" && parsed === null && (
        <p className="text-xs text-rose-700">
          Not a quantity I can read. Try a number with a unit, like{" "}
          {estimate.kind === "bytes" || estimate.kind === "byte-rate" ? "79 TB" : "86M"}.
        </p>
      )}
      {parsed !== null && parsed !== value && (
        <p className="text-xs text-zinc-500">Reads as {formatQuantity(parsed, estimate.kind)}.</p>
      )}
      {result.band !== null && (
        <p className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${BAND_STYLE[result.band]}`}>
            {verdict(result)}
          </span>
        </p>
      )}
      {revealed ? (
        <div className="flex flex-col gap-1 rounded-md bg-zinc-50 p-2 text-xs text-zinc-700">
          <p className="font-medium text-zinc-900">
            About {formatQuantity(estimate.answer, estimate.kind)}
          </p>
          <Prose text={estimate.derivation} />
        </div>
      ) : (
        <button
          type="button"
          className="self-start text-xs text-zinc-600 underline hover:text-zinc-900"
          onClick={() => setRevealed(true)}
        >
          {value === null ? "Show the answer" : "Show how"}
        </button>
      )}
    </li>
  );
}
