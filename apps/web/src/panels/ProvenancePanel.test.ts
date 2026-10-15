import { describe, expect, it } from "vitest";
import { requestPrice, unitsText } from "./ProvenancePanel";

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

describe("unitsText", () => {
  it("says what a unit covers and whether batches share it", () => {
    expect(unitsText({ per: "item", readBytes: 4096, writeBytes: 1024, readUnits: 0.5 })).toBe(
      "reads one per 4 KB (½ unit), writes one per 1 KB, per item",
    );
    expect(unitsText({ per: "request", readBytes: 65536, writeBytes: 65536, readUnits: 1 })).toBe(
      "one per 64 KB, per request's payload",
    );
  });
});
