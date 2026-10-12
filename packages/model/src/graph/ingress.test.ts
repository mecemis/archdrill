import { describe, expect, it } from "vitest";
import type { Attempt } from "../attempt/schema";
import { applyCommand } from "../commands/index";
import { cacheAsideAttempt, testCatalogIndex } from "../testing/fixtures";
import { findIngressRoute } from "./ingress";

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

  it("ignores asynchronous connections", () => {
    const attempt = applyCommand(cacheAsideAttempt(), "setConnectionMode", {
      id: "lb--api",
      mode: "async",
    }).attempt;

    expect(route(attempt, "api")).toBeNull();
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
