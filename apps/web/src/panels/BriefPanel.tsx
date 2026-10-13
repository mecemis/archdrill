import { Lightbulb } from "lucide-react";
import { useState } from "react";
import { activePack } from "../state/content";
import { useEvaluation } from "../state/evaluation";
import { useAttemptStore } from "../state/store";
import { useUi } from "../state/ui-store";
import { Prose } from "../ui/Prose";
import { Button, SectionTitle } from "../ui/primitives";

export function BriefPanel() {
  const scenarioId = useUi((s) => s.scenarioId);
  const scenario = activePack.scenarios.find((s) => s.id === scenarioId);
  const { problem } = activePack;
  const estimates = useAttemptStore((s) => s.attempt.estimates);
  const [derivedShown, setDerivedShown] = useState(false);
  // Derived numbers give the estimates away: they wait until the candidate has worked them out.
  const showDerived = derivedShown || problem.estimates.every((e) => estimates[e.id] !== undefined);
  const focusRequirements = new Set(
    problem.operations
      .filter((op) => scenario?.focusOperations.includes(op.id))
      .flatMap((op) => op.requirements),
  );

  return (
    <div className="flex flex-col gap-5 p-4 text-sm text-zinc-800">
      {scenario && (
        <section className="flex flex-col gap-2">
          <SectionTitle>Scenario</SectionTitle>
          <p className="font-semibold text-zinc-900">{scenario.title}</p>
          <Prose text={scenario.story} className="text-zinc-700" />
          <HintList key={scenario.id} hints={scenario.hints} />
          {scenario.debrief && <Debrief scenarioId={scenario.id} text={scenario.debrief} />}
        </section>
      )}
      <section className="flex flex-col gap-2">
        <SectionTitle>Problem</SectionTitle>
        <Prose text={problem.brief} className="text-zinc-700" />
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {problem.scale.map((item) => (
            <div key={item.label} className="contents">
              <dt className="font-medium text-zinc-500">{item.label}</dt>
              <dd className="text-zinc-800">
                {item.value}
                {item.note && showDerived && <span className="text-zinc-500"> · {item.note}</span>}
              </dd>
            </div>
          ))}
        </dl>
        {!showDerived && problem.scale.some((item) => item.note) && (
          <p className="text-xs text-zinc-500">
            Work out the derived numbers under Estimate, or{" "}
            <button
              type="button"
              className="underline hover:text-zinc-900"
              onClick={() => setDerivedShown(true)}
            >
              show them now
            </button>
            .
          </p>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <SectionTitle>Requirements</SectionTitle>
        <ul className="flex flex-col gap-1.5">
          {problem.requirements.map((req) => (
            <li
              key={req.id}
              className={`rounded-md px-2 py-1 ${focusRequirements.has(req.id) ? "bg-sky-50 text-zinc-900" : "text-zinc-500"}`}
            >
              <span className="mr-1.5 font-mono text-xs font-semibold">{req.id}</span>
              {req.text}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Follow-up questions an interviewer would ask, once the scenario passes. */
function Debrief({ scenarioId, text }: { readonly scenarioId: string; readonly text: string }) {
  const result = useEvaluation().scenarios.find((s) => s.scenarioId === scenarioId);
  if (result?.status !== "evaluated" || result.scorecard.band === "not-passing") return null;
  return (
    <div className="flex flex-col gap-1 rounded-md bg-sky-50 px-2.5 py-2 text-sky-950">
      <p className="font-semibold">Debrief</p>
      <Prose text={text} />
    </div>
  );
}

function HintList({ hints }: { readonly hints: readonly string[] }) {
  const [shown, setShown] = useState(0);
  if (hints.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {hints.slice(0, shown).map((hint, index) => (
        <p key={hint} className="rounded-md bg-amber-50 px-2.5 py-2 text-amber-950">
          <span className="font-semibold">Hint {index + 1}.</span> {hint}
        </p>
      ))}
      {shown < hints.length && (
        <Button variant="ghost" className="self-start" onClick={() => setShown(shown + 1)}>
          <Lightbulb className="h-4 w-4" />
          Show hint {shown + 1} of {hints.length}
        </Button>
      )}
    </div>
  );
}
