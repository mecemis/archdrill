import {
  type ActionId,
  type Attempt,
  getAction,
  getLogic,
  type Operation,
  outcomeTone,
  type Problem,
  type Step,
  type StepInput,
} from "@archdrill/model";

/**
 * Outcomes after which a request carries on with the next step, by
 * convention: a cache miss (or a cache that cannot answer) goes on to the
 * store, a failed cache write does not stop the request, and anything else
 * carries on when it succeeded.
 */
const CONTINUING: Partial<Record<ActionId, readonly string[]>> = {
  "cache.get": ["miss", "error"],
  "cache.set": ["ok", "error"],
  "cache.setNegative": ["ok", "error"],
  "cache.delete": ["ok", "error"],
};

type AnyStep = Step | StepInput;

/** The outcomes that lead to the next step of the list, most important first. */
export function continuingOutcomes(step: AnyStep): readonly string[] {
  if (step.type === "respond") return [];
  const outcomes =
    step.type === "call" ? getAction(step.action).outcomes : getLogic(step.logic).outcomes;
  if (step.type === "call") {
    const known = CONTINUING[step.action];
    if (known) return known.filter((o) => outcomes.includes(o));
  }
  const positive = outcomes.filter((o) => outcomeTone(o) === "positive");
  return positive.length > 0 ? positive : outcomes.slice(0, 1);
}

/** Statuses outcomes that end a request usually answer with. */
const STATUS_BY_OUTCOME: Readonly<Record<string, number>> = {
  error: 503,
  invalid: 400,
  malicious: 400,
  notFound: 404,
  negativeHit: 404,
  expired: 410,
  disabled: 410,
  declined: 402,
  over: 429,
  conflict: 409,
};

/**
 * The status a request ends with when it succeeds: the candidate's own choice
 * where a decision picks it (which redirect status), otherwise the
 * operation's first success below 400.
 */
export function successStatus(operation: Operation, problem: Problem, attempt: Attempt): number {
  const statusOf = (id: string) => Number.parseInt(id, 10);
  const point = problem.decisionPoints.find((d) =>
    d.options.some((o) => operation.successStatuses.includes(statusOf(o.id))),
  );
  const chosen = point ? (attempt.decisions[point.id] ?? point.default) : undefined;
  if (chosen !== undefined && operation.successStatuses.includes(statusOf(chosen))) {
    return statusOf(chosen);
  }
  return operation.successStatuses.find((s) => s < 400) ?? 200;
}

export interface ExitContext {
  readonly operation: Operation;
  readonly problem: Problem;
  readonly attempt: Attempt;
  /** Consumers and jobs only finish (200) or ask to be tried again (503). */
  readonly background: boolean;
}

/**
 * Outcomes that call for another step (a verdict to act on, a match to
 * confirm), which a consumer must not simply finish on.
 */
const ACT_ON = new Set(["malicious", "match"]);

/**
 * How a new step's other outcomes end by default, or null to leave the
 * outcome for the candidate to decide.
 */
export function defaultExitStatus(outcome: string, ctx: ExitContext): number | null {
  const tone = outcomeTone(outcome);
  if (ctx.background) return ACT_ON.has(outcome) ? null : tone === "error" ? 503 : 200;
  const known = STATUS_BY_OUTCOME[outcome];
  if (known !== undefined) return known;
  if (tone === "positive") return successStatus(ctx.operation, ctx.problem, ctx.attempt);
  return null;
}
