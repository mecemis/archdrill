import { describe, expect, it } from "vitest";
import { type Attempt, AttemptSchema } from "../attempt/schema";
import { applyCommand } from "../commands/index";
import { asyncAttempt } from "../testing/async";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "../testing/fixtures";
import { findIngressRoute, findOperationRoute } from "./ingress";

function route(attempt: Attempt, handler: string) {
  return findIngressRoute(attempt.architecture, testCatalogIndex, handler);
}

describe("findIngressRoute", () => {
  it("routes from the client through the load balancer to the handler", () => {
    expect(route(cacheAsideAttempt(), "api")).toEqual({
      components: ["client", "lb", "api"],
      connections: ["client--lb", "lb--api"],
    });
  });

  it("returns null when the path points the wrong way", () => {
    const attempt = applyCommand(cacheAsideAttempt(), "reverseConnection", {
      id: "lb--api",
    }).attempt;

    expect(route(attempt, "api")).toBeNull();
  });

  it("routes over a connection saved as asynchronous: connections have no mode", () => {
    const saved = JSON.parse(JSON.stringify(cacheAsideAttempt()));
    for (const connection of saved.architecture.connections) connection.mode = "async";

    expect(route(AttemptSchema.parse(saved), "api")).not.toBeNull();
  });

  it("does not route through components that cannot forward traffic", () => {
    let attempt = cacheAsideAttempt();
    attempt = applyCommand(attempt, "addComponent", {
      id: "api2",
      kind: "service",
      flavor: "generic",
      label: "Second API",
      position: { x: 0, y: 0 },
    }).attempt;
    attempt = applyCommand(attempt, "addConnection", { from: "db", to: "api2" }).attempt;

    expect(route(attempt, "api2")).toBeNull();
  });

  it("prefers the shortest route", () => {
    const attempt = applyCommand(cacheAsideAttempt(), "addConnection", {
      from: "client",
      to: "api",
    }).attempt;

    expect(route(attempt, "api")?.components).toEqual(["client", "api"]);
  });
});

describe("findOperationRoute", () => {
  const operation = (id: string) => {
    const op = testProblem.operations.find((o) => o.id === id);
    if (!op) throw new Error(id);
    return op;
  };
  const routeOf = (attempt: Attempt, id: string, handler: string) =>
    findOperationRoute(operation(id), attempt, testCatalogIndex, handler);

  it("delivers a consumer's messages from the queue its event is published to", () => {
    expect(routeOf(asyncAttempt(), "scan-link", "worker")).toEqual({
      components: ["queue", "worker"],
      connections: ["worker--queue"],
    });
  });

  it("accepts a consumer connection drawn from the queue to the consumer", () => {
    const attempt = applyCommand(asyncAttempt(), "reverseConnection", {
      id: "worker--queue",
    }).attempt;

    expect(routeOf(attempt, "scan-link", "worker")).toEqual({
      components: ["queue", "worker"],
      connections: ["queue--worker"],
    });
  });

  it("starts a scheduled job in its own handler", () => {
    expect(routeOf(asyncAttempt(), "purge-expired", "worker")).toEqual({
      components: ["worker"],
      connections: [],
    });
  });

  it("finds no route to a consumer of an event nobody publishes", () => {
    const attempt = applyCommand(asyncAttempt(), "removeStep", {
      operation: "create-link",
      stepId: "publish",
      bypass: "ok",
    }).attempt;

    expect(routeOf(attempt, "scan-link", "worker")).toBeNull();
  });

  it("ignores a publish step that no request reaches", () => {
    const attempt = applyCommand(asyncAttempt(), "linkOutcome", {
      operation: "create-link",
      stepId: "insert",
      outcome: "ok",
      target: "r201",
    }).attempt;
    const unreachable = applyCommand(attempt, "linkOutcome", {
      operation: "create-link",
      stepId: "insert-alias",
      outcome: "ok",
      target: "r201",
    }).attempt;

    expect(routeOf(unreachable, "scan-link", "worker")).toBeNull();
  });

  it("routes requests from a client as before", () => {
    expect(routeOf(asyncAttempt(), "redirect", "api")?.components).toEqual(["client", "lb", "api"]);
  });
});
