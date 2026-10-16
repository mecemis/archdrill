import { describe, expect, it } from "vitest";
import { EnvironmentSchema, RequestClassSchema, TimelineSchema } from "./workload";

describe("RequestClassSchema", () => {
  it("only lets alias requests find their alias taken", () => {
    expect(
      RequestClassSchema.safeParse({ id: "taken", share: 0.1, aliasTaken: true }).success,
    ).toBe(false);
    expect(
      RequestClassSchema.safeParse({ id: "taken", share: 0.1, customAlias: true, aliasTaken: true })
        .success,
    ).toBe(true);
  });
});

describe("a lost region", () => {
  const timeline = (events: unknown[]) =>
    TimelineSchema.safeParse({ id: "t", label: "T", durationSec: 300, rates: {}, events });
  const lost = (extra: Record<string, unknown> = {}) => ({
    kind: "fault",
    at: 30,
    fault: { kind: "region-down" },
    ...extra,
  });

  it("is lost for good in a timeline, since failing back is not modelled", () => {
    expect(timeline([lost()]).success).toBe(true);
    expect(timeline([lost({ until: 200 })]).error?.issues[0]?.message).toBe(
      "event 0 ends a lost region, but failing back to it is not modelled",
    );
  });

  it("is lost once per timeline", () => {
    expect(timeline([lost(), lost({ at: 100 })]).error?.issues[0]?.message).toBe(
      "a timeline loses the region at most once",
    );
  });

  it("is not combined with a lost zone, which would be in it", () => {
    const zone = { kind: "fault", at: 10, fault: { kind: "zone-down" } };
    expect(timeline([zone, lost()]).success).toBe(false);
    const env = EnvironmentSchema.safeParse({
      id: "e",
      label: "E",
      rates: {},
      faults: [{ kind: "zone-down" }, { kind: "region-down" }],
    });
    expect(env.error?.issues[0]?.message).toBe("a lost zone and a lost region cannot be combined");
  });
});
