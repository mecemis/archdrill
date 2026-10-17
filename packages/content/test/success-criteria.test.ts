import { evaluateAttempt, type ScenarioResult } from "@archdrill/evaluator";
import {
  type Attempt,
  AttemptSchema,
  applyCommand,
  type CommandName,
  validateAttempt,
} from "@archdrill/model";
import { describe, expect, it } from "vitest";
import { catalogIndex, getProblemPack } from "../src/index";
import { corpora } from "./corpus";

const pack = getProblemPack("url-shortener");
if (!pack) throw new Error("url-shortener pack missing");
const input = { ...pack, catalog: catalogIndex };
const corpus = corpora.find((c) => c.problemId === "url-shortener");
if (!corpus) throw new Error("url-shortener corpus missing");

/** One component of every popular kind, chained, plus a client. */
const BUZZWORDS: readonly [id: string, kind: string, flavor: string][] = [
  ["lb", "load-balancer", "alb"],
  ["gateway", "api-gateway", "kong"],
  ["api", "service", "generic"],
  ["redis", "cache", "redis"],
  ["postgres", "relational-db", "postgres"],
  ["dynamo", "key-value-db", "dynamodb"],
  ["kgs", "id-generator", "kgs"],
  ["etcd", "coordination", "etcd"],
  ["queue", "queue", "kafka"],
  ["safety", "external-api", "url-safety"],
];

/**
 * The "buzzword" design: every popular component wired in one chain, and
 * flows that answer at once without using any of them.
 */
function buzzwordDesign(): Attempt {
  let attempt = AttemptSchema.parse({
    schemaVersion: 1,
    problemId: "url-shortener",
    problemVersion: pack?.problem.version ?? 1,
    architecture: {
      components: [{ id: "visitors", kind: "client", flavor: "browser", label: "Visitors" }],
    },
  });
  const run = <N extends CommandName>(name: N, args: Parameters<typeof applyCommand<N>>[2]) => {
    attempt = applyCommand(attempt, name, args).attempt;
  };
  let previous = "visitors";
  for (const [id, kind, flavor] of BUZZWORDS) {
    const kindDef = catalogIndex.kind(kind);
    const flavorDef = catalogIndex.flavor(kind, flavor);
    run("addComponent", {
      id,
      kind,
      flavor,
      label: `${kindDef?.label ?? kind}`,
      ...(flavorDef?.defaultSize ? { size: flavorDef.defaultSize } : {}),
      replicas: kindDef?.replicable ? 3 : 1,
      position: { x: 0, y: 0 },
    });
    if (kindDef?.holdsData) run("setComponentData", { id, entities: ["Link"] });
    run("addConnection", { from: previous, to: id });
    previous = id;
  }
  const answer = (operation: string, status: number) => {
    run("createFlow", { operation, handler: "api" });
    run("addStep", {
      operation,
      step: { type: "respond", status },
      attach: { to: "root" },
    });
  };
  answer("redirect", 302);
  answer("create-link", 201);
  answer("disable-link", 204);
  answer("purge-expired", 200);
  return attempt;
}

const bandOf = (result: ScenarioResult) =>
  result.status === "evaluated" ? result.scorecard.band : result.status;

describe("success criteria", () => {
  it("does not let a design pass on buzzwords alone, in any scenario", () => {
    const design = buzzwordDesign();
    const errors = validateAttempt(design, { catalog: catalogIndex, problem: input.problem });
    expect(errors.filter((i) => i.severity === "error")).toEqual([]);

    const bands = evaluateAttempt(design, input).scenarios.map(
      (s) => `${s.scenarioId}: ${bandOf(s)}`,
    );

    expect(bands).toEqual(input.scenarios.map((s) => `${s.id}: not-passing`));
  });

  // Every golden design and mutant in every scenario: one test per scenario, so
  // no single test runs into the timeout as the corpus grows.
  const designs = [
    ...corpus.golden.map((g) => ({ id: g.id, attempt: g.attempt })),
    ...corpus.mutants.flatMap((m) => {
      const base = corpus.golden.find((g) => g.id === m.base);
      if (!base) return [];
      const attempt = m.apply.reduce(
        (a, step) => applyCommand(a, step.name as CommandName, step.args as never).attempt,
        base.attempt,
      );
      return [{ id: m.id, attempt }];
    }),
  ];
  for (const scenario of pack.scenarios) {
    it(`gives every finding evidence to point at and a fix in ${scenario.id}`, {
      timeout: 120_000,
    }, () => {
      const missing: string[] = [];
      for (const design of designs) {
        for (const result of evaluateAttempt(design.attempt, { ...input, scenarios: [scenario] })
          .scenarios) {
          if (result.status !== "evaluated") continue;
          for (const check of result.checks) {
            if (check.status !== "fail" && check.status !== "partial") continue;
            if (check.evidence.length === 0 || check.instance.fix.trim() === "") {
              missing.push(`${design.id} ${result.scenarioId}/${check.instance.id}`);
            }
          }
        }
      }

      expect(missing).toEqual([]);
    });
  }
});
