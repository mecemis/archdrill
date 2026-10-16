import type { TimelineMetrics } from "@archdrill/engine";
import { describe, expect, it } from "vitest";
import { timelineSnapshot } from "./timeline-view";

/** Just what a snapshot reads: two steps of one component and one connection. */
function metrics(): TimelineMetrics {
  return {
    times: [0, 1],
    components: new Map([
      [
        "db",
        {
          utilization: [0.4, 1.3],
          instances: [2, 3],
          latencyMs: [2, 40],
          faults: [[], ["Primary down"]],
          faultDisrupts: [false, true],
        },
      ],
    ]),
    connections: new Map([["api--db", [100, 250]]]),
  } as unknown as TimelineMetrics;
}

describe("timelineSnapshot", () => {
  it("shows the canvas the load at the picked step", () => {
    const snapshot = timelineSnapshot(metrics(), 1);

    expect(snapshot.components.get("db")).toEqual({
      utilization: 1.3,
      hottestShardUtilization: 1.3,
      instances: 3,
      faults: ["Primary down"],
      faultDisrupts: true,
    });
    expect(snapshot.connections.get("api--db")).toBe(250);
  });

  it("shows an idle design past the end of the series", () => {
    const snapshot = timelineSnapshot(metrics(), 5);

    expect(snapshot.components.get("db")).toMatchObject({
      utilization: 0,
      faults: [],
      faultDisrupts: false,
    });
    expect(snapshot.connections.get("api--db")).toBe(0);
  });
});
