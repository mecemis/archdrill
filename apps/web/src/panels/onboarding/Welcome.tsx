import { examplesFor } from "@archdrill/content";
import { BookOpenText, Gauge, Route } from "lucide-react";
import { useEffect, useRef } from "react";
import { activePack } from "../../state/content";
import { useOnboarding } from "../../state/onboarding";
import { Button } from "../../ui/primitives";
import { openExample } from "./actions";

const POINTS = [
  {
    icon: BookOpenText,
    title: "Read the scenario",
    text: "Each scenario is an interviewer's prompt: traffic, failures and requirements to design for.",
  },
  {
    icon: Route,
    title: "Design it, then say what happens",
    text: "Put components on the canvas and connect them. Then build a flow for each request: what the service calls, and what happens when a call succeeds, misses or fails.",
  },
  {
    icon: Gauge,
    title: "Get evaluated as you go",
    text: "Every change is simulated under the scenario's load. The score and findings say what breaks, why an interviewer would care, and how to fix it.",
  },
] as const;

/** Shown on a first visit, and again from the help menu. */
export function Welcome() {
  const welcomed = useOnboarding((s) => s.welcomed);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element || welcomed) return;
    // jsdom has no showModal; an open dialog is enough there.
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
  }, [welcomed]);

  if (welcomed) return null;
  const finish = (then?: () => void) => {
    dialog.current?.close();
    useOnboarding.getState().finishWelcome();
    then?.();
  };
  const example = examplesFor(activePack.problem.id)[0];

  return (
    <dialog
      ref={dialog}
      aria-labelledby="welcome-title"
      onCancel={() => finish()}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-2xl border border-line bg-elevated p-0 text-fg shadow-pop backdrop:bg-black/40 backdrop:backdrop-blur-[2px]"
    >
      <div className="flex flex-col gap-5 p-6">
        <div className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-lg font-bold text-on-accent"
            aria-hidden="true"
          >
            A
          </span>
          <div>
            <h2 id="welcome-title" className="text-lg font-semibold">
              Welcome to ArchDrill
            </h2>
            <p className="text-sm text-fg-muted">
              Practise system design interviews on {activePack.problem.title} and four more
              problems.
            </p>
          </div>
        </div>
        <ol className="flex flex-col gap-3">
          {POINTS.map(({ icon: Icon, title, text }, index) => (
            <li key={title} className="flex gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-fg">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="flex flex-col">
                <span className="text-sm font-semibold">
                  {index + 1}. {title}
                </span>
                <span className="text-sm text-fg-muted">{text}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={() => finish(() => useOnboarding.getState().setGuideOpen(true))}
          >
            Guide me through the first scenario
          </Button>
          {example && (
            <Button onClick={() => finish(() => openExample(example))}>
              Open an example design
            </Button>
          )}
          <Button variant="ghost" onClick={() => finish()}>
            I'll explore on my own
          </Button>
        </div>
      </div>
    </dialog>
  );
}
