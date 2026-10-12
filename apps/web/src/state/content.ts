import { catalogIndex, getProblemPack, type ProblemPack } from "@archdrill/content";

const DEFAULT_PROBLEM_ID = "url-shortener";

function requirePack(problemId: string): ProblemPack {
  const pack = getProblemPack(problemId);
  if (!pack) throw new Error(`Problem pack "${problemId}" is not available.`);
  return pack;
}

/** The problem pack the app is working on. Multiple problems arrive with v0.3. */
export const activePack: ProblemPack = requirePack(DEFAULT_PROBLEM_ID);
export { catalogIndex };
