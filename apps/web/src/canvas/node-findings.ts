import type { Analysis } from "@archdrill/engine";
import type { CheckResult } from "@archdrill/evaluator";
import type { Attempt } from "@archdrill/model";
import { highlightFromEvidence } from "../state/evaluation";
import type { Highlight } from "../state/ui-store";

/** How serious a component's worst open finding is. */
export type FindingTone = "bad" | "warn" | "info";

/** The open findings that point at one component, led by the most serious. */
export interface NodeFindings {
  readonly count: number;
  readonly tone: FindingTone;
  /** The most serious finding: its id, title and what it highlights. */
  readonly key: string;
  readonly title: string;
  readonly highlight: Highlight;
}

const TONE_RANK: Readonly<Record<FindingTone, number>> = { bad: 0, warn: 1, info: 2 };

function toneOf(check: CheckResult): FindingTone {
  if (check.gateFailed || check.instance.severity === "critical") return "bad";
  return check.instance.severity === "major" ? "warn" : "info";
}

/** Open baseline findings: what the Findings tab lists first. */
export function openFindings(checks: readonly CheckResult[]): CheckResult[] {
  return checks.filter(
    (c) => c.instance.signal === "baseline" && (c.status === "fail" || c.status === "partial"),
  );
}

/**
 * Components a finding is about: the ones it names, and the targets of the
 * flow steps it names. Paths and connections are left out; a whole path would
 * mark every component on it.
 */
function componentsOf(check: CheckResult, attempt: Attempt): Set<string> {
  const ids = new Set<string>();
  for (const item of check.evidence) {
    if (item.type === "component") ids.add(item.componentId);
    if (item.type === "step") {
      const step = attempt.flows.find((f) => f.operation === item.operation)?.steps[item.stepId];
      if (step?.type === "call") ids.add(step.target);
    }
  }
  return ids;
}

/** Open findings per component, for badges on the canvas. */
export function findingsByComponent(
  checks: readonly CheckResult[],
  attempt: Attempt,
  analysis: Analysis,
): ReadonlyMap<string, NodeFindings> {
  const result = new Map<string, NodeFindings>();
  for (const check of openFindings(checks)) {
    const tone = toneOf(check);
    for (const id of componentsOf(check, attempt)) {
      const current = result.get(id);
      const leads = !current || TONE_RANK[tone] < TONE_RANK[current.tone];
      result.set(id, {
        count: (current?.count ?? 0) + 1,
        tone: leads ? tone : (current?.tone ?? tone),
        key: leads ? check.instance.id : (current?.key ?? check.instance.id),
        title: leads ? check.instance.title : (current?.title ?? check.instance.title),
        highlight:
          leads || !current ? highlightFromEvidence(check.evidence, analysis) : current.highlight,
      });
    }
  }
  return result;
}
