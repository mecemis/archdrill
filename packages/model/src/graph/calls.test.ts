import { describe, expect, it } from "vitest";
import type { Attempt } from "../attempt/schema";
import { applyCommand, type CommandArgs, type CommandName } from "../commands/index";
import { asyncAttempt } from "../testing/async";
import { cacheAsideAttempt, testCatalogIndex } from "../testing/fixtures";
import { withNearCache } from "../testing/near-cache";
import { callableFrom, connectionToCall } from "./calls";

function apply<N extends CommandName>(attempt: Attempt, name: N, args: CommandArgs<N>): Attempt {
  return applyCommand(attempt, name, args).attempt;
}

const withQueue = (attempt: Attempt) =>
  apply(attempt, "addComponent", {
    id: "queue",
    kind: "queue",
    flavor: "managed-queue",
    label: "Link events",
    position: { x: 0, y: 0 },
  });

describe("callableFrom", () => {
  it("offers what offers an action, connected or not, but not clients, itself or a load balancer", () => {
    expect(callableFrom("api", withQueue(cacheAsideAttempt()), testCatalogIndex)).toEqual([
      "redis",
      "db",
      "queue",
    ]);
  });

  it("keeps an in-process cache to the one service that runs it", () => {
    const attempt = apply(
      apply(withNearCache(cacheAsideAttempt()), "addComponent", {
        id: "api2",
        kind: "service",
        flavor: "generic",
        label: "Second API",
        position: { x: 0, y: 0 },
      }),
      "addConnection",
      { from: "api2", to: "db" },
    );

    expect(callableFrom("api", attempt, testCatalogIndex)).toContain("near");
    expect(callableFrom("api2", attempt, testCatalogIndex)).not.toContain("near");
  });
});

describe("connectionToCall", () => {
  it("needs nothing over an existing connection, and a new one otherwise", () => {
    const attempt = withQueue(cacheAsideAttempt());

    expect(connectionToCall("api", "db", attempt, testCatalogIndex)).toEqual({ kind: "connected" });
    expect(connectionToCall("api", "queue", attempt, testCatalogIndex)).toEqual({ kind: "add" });
  });

  it("turns round the connection a queue delivers to its consumer over", () => {
    const delivered = apply(asyncAttempt(), "reverseConnection", { id: "worker--queue" });

    expect(connectionToCall("worker", "queue", delivered, testCatalogIndex)).toEqual({
      kind: "reverse",
      id: "queue--worker",
    });
  });

  it("adds its own connection to a store drawn towards the service", () => {
    const backwards = apply(cacheAsideAttempt(), "reverseConnection", { id: "api--db" });

    expect(connectionToCall("api", "db", backwards, testCatalogIndex)).toEqual({ kind: "add" });
  });
});
