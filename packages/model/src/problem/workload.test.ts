import { describe, expect, it } from "vitest";
import { RequestClassSchema } from "./workload";

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
