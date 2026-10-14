import { describe, expect, it } from "vitest";
import { requestPrice } from "./ProvenancePanel";

describe("requestPrice", () => {
  it("quotes cheap requests per million, reads and writes apart", () => {
    expect(requestPrice({ readPerMillion: 0.125, writePerMillion: 0.625 })).toBe(
      "$0.125 per million reads, $0.625 per million writes",
    );
  });

  it("quotes API calls per 1,000, as their vendors do", () => {
    expect(requestPrice({ readPerMillion: 500, writePerMillion: 500 })).toBe(
      "$0.50 per 1,000 calls",
    );
    expect(requestPrice({ readPerMillion: 50_000, writePerMillion: 50_000 })).toBe(
      "$50 per 1,000 calls",
    );
  });
});
