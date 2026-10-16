import { type Attempt, applyCommand, type CommandArgs, WorkloadSchema } from "@archdrill/model";
import { cacheAsideAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { runCheckWithLoad } from "../test-support";

const workload = WorkloadSchema.parse({
  operations: { redirect: { entity: "Link", classes: [{ id: "live", share: 1 }] } },
  keys: { Link: { existing: { distribution: "zipf", s: 1.05, population: 2e8 } } },
  environments: [{ id: "avg", label: "Average", rates: { redirect: 6000 } }],
});

function apply<N extends Parameters<typeof applyCommand>[1]>(
  attempt: Attempt,
  name: N,
  args: CommandArgs<N>,
): Attempt {
  return applyCommand(attempt, name, args).attempt;
}

function spread(zones: number): Attempt {
  return ["api", "redis", "db"].reduce(
    (a, id) => apply(a, "updateComponent", { id, replicas: 3, zones }),
    cacheAsideAttempt(),
  );
}

const run = (attempt: Attempt) =>
  runCheckWithLoad("zone-local-calls", { environment: "avg", minMonthlyUsd: 1 }, attempt, workload);

describe("zone-local-calls", () => {
  it("names the calls that zone-aware routing would keep in their zone, and the saving", () => {
    const outcome = run(spread(3));

    expect(outcome.status).toBe("fail");
    expect(outcome.message).toMatch(/zone-aware routing would save \$\d/);
    expect(outcome.details[0]).toMatch(/^Link API → (Redis|Postgres): 67% of calls cross zones/);
    expect(outcome.evidence).toContainEqual({ type: "connection", connectionId: "api--redis" });
  });

  it("tells reads from writes where they cross zones in different shares", () => {
    // Two zones of callers: reads spread over Redis's three zones, writes go to its primary in one.
    const twoZones = apply(spread(3), "updateComponent", { id: "api", replicas: 2, zones: 2 });

    const toCache = run(twoZones).details.find((line) => line.startsWith("Link API → Redis"));

    expect(toCache).toMatch(/^Link API → Redis: 67% of reads and 50% of writes cross zones, \$/);
  });

  it("passes once the calls that can stay in their zone do", () => {
    const aware = ["api--redis", "api--db"].reduce(
      (a, id) => apply(a, "setConnectionPolicy", { id, sameZone: true }),
      spread(3),
    );

    const outcome = run(aware);

    expect(outcome.status).toBe("pass");
    expect(outcome.message).toMatch(/none of it that zone-aware routing would save/);
  });

  it("does not apply when every component runs in one zone", () => {
    expect(run(spread(1)).status).toBe("n/a");
  });
});
