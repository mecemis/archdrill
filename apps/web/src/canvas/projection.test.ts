import { analyzeAttempt } from "@archdrill/engine";
import { applyCommand } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { findingsByComponent } from "./node-findings";
import { healthOf, type ProjectionInput, projectEdges, projectNodes } from "./projection";

function inputFor(
  attempt = cacheAsideAttempt(),
  overrides: Partial<ProjectionInput> = {},
): ProjectionInput {
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  return {
    attempt,
    catalog: testCatalogIndex,
    operation: analysis.operations.get("redirect"),
    issues: analysis.issues,
    highlight: null,
    selection: null,
    slotArmed: false,
    ...overrides,
  };
}

describe("projection", () => {
  it("numbers the active flow's steps on the connections they use", () => {
    const edges = projectEdges(inputFor());
    const steps = Object.fromEntries(edges.map((e) => [e.id, e.data?.steps]));

    expect(steps).toEqual({
      "client--lb": [],
      "lb--api": [],
      "api--redis": [1, 5],
      "api--db": [3],
    });
  });

  it("marks the ingress route and the handler", () => {
    const input = inputFor();
    const ingress = projectEdges(input)
      .filter((e) => e.data?.ingress)
      .map((e) => e.id);
    const handler = projectNodes(input).find((n) => n.data.isHandler)?.id;

    expect(ingress).toEqual(["client--lb", "lb--api"]);
    expect(handler).toBe("api");
  });

  it("dims everything outside the active highlight", () => {
    const highlight = {
      components: new Set(["db"]),
      connections: new Set<string>(),
      steps: new Set<string>(),
      decisions: new Set<string>(),
    };
    const nodes = projectNodes(inputFor(undefined, { highlight }));

    expect(nodes.find((n) => n.id === "db")?.data.emphasis).toBe("highlighted");
    expect(nodes.find((n) => n.id === "redis")?.data.emphasis).toBe("dimmed");
  });

  it("offers the handler's synchronous dependencies as call targets while a slot is armed", () => {
    const callable = projectNodes(inputFor(undefined, { slotArmed: true }))
      .filter((n) => n.data.callable)
      .map((n) => n.id);

    expect(callable).toEqual(["redis", "db"]);
  });

  it("carries simulated utilisation to nodes and rates to connections", () => {
    const metrics = {
      components: new Map([
        [
          "db",
          {
            utilization: 0.42,
            hottestShardUtilization: 0.42,
            instances: 1,
            faults: [],
            faultDisrupts: false,
          },
        ],
      ]),
      connections: new Map([["api--db", 1234]]),
    } as unknown as ProjectionInput["metrics"];
    const input = inputFor(undefined, { metrics });

    expect(projectNodes(input).find((n) => n.id === "db")?.data.utilization).toBe(0.42);
    expect(projectNodes(input).find((n) => n.id === "redis")?.data.utilization).toBeNull();
    expect(projectEdges(input).find((e) => e.id === "api--db")?.data?.rate).toBe(1234);
    expect(projectEdges(inputFor()).find((e) => e.id === "api--db")?.data?.rate).toBeNull();
  });

  it("rates health from load, hot shards and faults", () => {
    const load = (utilization: number, hottest = utilization, faults: string[] = []) => ({
      utilization,
      hottestShardUtilization: hottest,
      faults,
      faultDisrupts: faults.includes("down"),
    });

    expect(healthOf(undefined)).toBeNull();
    expect(healthOf(load(0.5))).toBe("ok");
    expect(healthOf(load(0.9))).toBe("warn");
    expect(healthOf(load(0.5, 0.9))).toBe("warn");
    expect(healthOf(load(1.2))).toBe("critical");
    expect(healthOf(load(0.1, 0.1, ["down"]))).toBe("critical");
    // Losing instances the rest absorb is worth a look, not an alarm.
    expect(healthOf(load(0.6, 0.6, ["lost 33% of its instances with a zone"]))).toBe("warn");
  });

  it("colours a connection by the health of the component it reaches", () => {
    const metrics = {
      components: new Map([
        [
          "db",
          {
            utilization: 1.3,
            hottestShardUtilization: 1.3,
            instances: 1,
            faults: [],
            faultDisrupts: false,
          },
        ],
      ]),
      connections: new Map([["api--db", 500]]),
    } as ProjectionInput["metrics"];
    const edges = projectEdges(inputFor(undefined, { metrics }));

    expect(edges.find((e) => e.id === "api--db")?.data?.targetHealth).toBe("critical");
    expect(edges.find((e) => e.id === "api--redis")?.data?.targetHealth).toBeNull();
  });

  it("badges components with the open findings that name them or their steps", () => {
    const attempt = cacheAsideAttempt();
    const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
    const finding = (id: string, severity: "critical" | "major" | "minor", evidence: unknown[]) =>
      ({
        instance: { id, title: id, severity, signal: "baseline" },
        status: "fail",
        gateFailed: false,
        evidence,
      }) as unknown as Parameters<typeof findingsByComponent>[0][number];
    const checks = [
      finding("minor-one", "minor", [{ type: "component", componentId: "db" }]),
      finding("critical-one", "critical", [
        { type: "step", operation: "redirect", stepId: "read" },
      ]),
    ];
    const findings = findingsByComponent(checks, attempt, analysis);
    const nodes = projectNodes(inputFor(attempt, { findings }));

    expect(nodes.find((n) => n.id === "db")?.data.findings).toMatchObject({
      count: 2,
      tone: "bad",
      key: "critical-one",
    });
    expect(nodes.find((n) => n.id === "redis")?.data.findings).toBeNull();
  });

  it("shows the zones a design spreads a component over, but not a managed one's", () => {
    const attempt = applyCommand(cacheAsideAttempt(), "updateComponent", {
      id: "api",
      zones: 3,
    }).attempt;

    const nodes = projectNodes(inputFor(attempt));

    expect(nodes.find((n) => n.id === "api")?.data.zones).toBe(3);
    expect(nodes.find((n) => n.id === "redis")?.data.zones).toBe(1);
    expect(nodes.find((n) => n.id === "lb")?.data.zones).toBeNull();
  });

  it("flags components with validation errors", () => {
    const attempt = applyCommand(cacheAsideAttempt(), "updateComponent", {
      id: "lb",
      replicas: 3,
    }).attempt;
    const nodes = projectNodes(inputFor(attempt));

    expect(nodes.find((n) => n.id === "lb")?.data.hasError).toBe(true);
  });

  it("leaves the canvas alone for a finding about a decision", () => {
    const highlight = {
      components: new Set<string>(),
      connections: new Set<string>(),
      steps: new Set<string>(),
      decisions: new Set(["code-reuse"]),
    };
    const nodes = projectNodes(inputFor(undefined, { highlight }));

    expect(nodes.every((n) => n.data.emphasis === "normal")).toBe(true);
  });
});
