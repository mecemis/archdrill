import { describe, expect, it } from "vitest";
import { withFill } from "./cache-loop";

describe("withFill", () => {
  it("keeps the hit ratio when every miss writes the entry back", () => {
    expect(withFill(0.8, 1)).toBe(0.8);
  });

  it("loses the entry when no miss writes it back", () => {
    expect(withFill(0.999, 0)).toBe(0);
  });

  it("spaces writes out when only some misses write", () => {
    // About 4 hits per write; with one write in two misses, 4 hits per 2 misses.
    expect(withFill(0.8, 0.5)).toBeCloseTo(4 / 6, 9);
  });
});
