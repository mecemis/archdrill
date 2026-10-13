import { applyCommand } from "@archdrill/model";
import { cacheAsideAttempt, testCatalogIndex, testProblem } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { analyzeAttempt } from "../analyze";
import { buildProfiles } from "./setup";
import { utilizationOf } from "./summary";

/** The cache-aside design with two gateways of 4 instances, each holding 1,000 connections. */
function withGateways() {
  let attempt = cacheAsideAttempt();
  for (const id of ["ws-1", "ws-2"]) {
    attempt = applyCommand(attempt, "addComponent", {
      id,
      kind: "websocket-gateway",
      flavor: "connection-servers",
      label: id,
      position: { x: 0, y: 0 },
    }).attempt;
    attempt = applyCommand(attempt, "updateComponent", { id, replicas: 4 }).attempt;
  }
  const analysis = analyzeAttempt(attempt, { catalog: testCatalogIndex, problem: testProblem });
  return { attempt, catalog: testCatalogIndex, problem: testProblem, analysis };
}

describe("persistent connections", () => {
  it("are shared by the gateways and fill their capacity", () => {
    const profiles = buildProfiles(withGateways(), new Map(), new Map(), false, 6000);
    const gateway = profiles.get("ws-1");
    if (!gateway) throw new Error("no gateway");

    expect(gateway.connectionCapacity).toBe(4000);
    expect(gateway.heldConnections).toBe(3000);
    expect(utilizationOf(undefined, gateway)).toBeCloseTo(0.75, 9);
    // Other components hold none.
    expect(profiles.get("api")?.heldConnections).toBe(0);
  });

  it("limit a gateway when they fill it before requests do", () => {
    const profiles = buildProfiles(withGateways(), new Map(), new Map(), false, 6000);
    const gateway = profiles.get("ws-1");
    if (!gateway) throw new Error("no gateway");

    // 40% of the request capacity, 75% of the connection capacity.
    expect(utilizationOf({ read: 0.4 * gateway.readCapacity, write: 0 }, gateway)).toBeCloseTo(
      0.75,
      9,
    );
    expect(utilizationOf({ read: 0.9 * gateway.readCapacity, write: 0 }, gateway)).toBeCloseTo(
      0.9,
      9,
    );
  });
});
