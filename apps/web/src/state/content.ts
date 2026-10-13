import { catalogIndex, getProblemPack, type ProblemPack, problemPacks } from "@archdrill/content";
import { safeStorage } from "./persistence";

const DEFAULT_PROBLEM_ID = "url-shortener";
const PROBLEM_KEY = "archdrill:problem";
const PROBLEM_PARAM = "problem";

/**
 * The problem the page works on: named in the address (`?problem=`), else the
 * one last chosen, else the first. Switching problems reloads the page, so
 * everything below can treat the active pack as fixed.
 */
function chosenProblemId(): string {
  const fromAddress =
    typeof location === "undefined"
      ? null
      : new URLSearchParams(location.search).get(PROBLEM_PARAM);
  let remembered: string | null = null;
  try {
    remembered = safeStorage()?.getItem(PROBLEM_KEY) ?? null;
  } catch {
    // Without storage the default applies.
  }
  const id = [fromAddress, remembered].find((c) => c !== null && getProblemPack(c) !== undefined);
  return id ?? DEFAULT_PROBLEM_ID;
}

function requirePack(problemId: string): ProblemPack {
  const pack = getProblemPack(problemId);
  if (!pack) throw new Error(`Problem pack "${problemId}" is not available.`);
  return pack;
}

/** The problem pack the app is working on. */
export const activePack: ProblemPack = requirePack(chosenProblemId());

/** Every problem the app offers, by id and title. */
export const problemChoices = problemPacks.map((p) => ({
  id: p.problem.id,
  title: p.problem.title,
}));

/** Opens another problem; each problem keeps its own design, so nothing is lost. */
export function openProblem(problemId: string): void {
  try {
    safeStorage()?.setItem(PROBLEM_KEY, problemId);
  } catch {
    // The address still carries the choice.
  }
  const url = new URL(location.href);
  url.searchParams.set(PROBLEM_PARAM, problemId);
  location.assign(url.toString());
}

export { catalogIndex };
