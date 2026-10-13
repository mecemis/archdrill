import { describe, expect, it } from "vitest";
import { formatQuantity, parseQuantity } from "./estimates";

describe("parseQuantity", () => {
  it.each([
    ["86.4M", "count", 86.4e6],
    ["158 billion", "count", 158e9],
    ["1,000", "count", 1000],
    ["3.5e12", "count", 3.5e12],
    ["3.5 × 10^12", "count", 3.5e12],
    ["300k/s", "rate", 300_000],
    ["300,000 per second", "rate", 300_000],
    ["79 TB", "bytes", 79e12],
    ["14.3GB", "bytes", 14.3e9],
    ["60 MB/s", "byte-rate", 60e6],
  ] as const)("reads %s", (text, kind, value) => {
    expect(parseQuantity(text, kind)).toBeCloseTo(value, 0);
  });

  it.each([
    ["", "count"],
    ["lots", "count"],
    ["0", "count"],
    ["79 TB", "count"],
    ["86M", "bytes"],
    ["-5", "rate"],
  ] as const)("rejects %j as a %s", (text, kind) => {
    expect(parseQuantity(text, kind)).toBeNull();
  });
});

describe("formatQuantity", () => {
  it("uses the largest unit that fits, with three significant digits", () => {
    expect(formatQuantity(86.4e6, "count")).toBe("86.4 M");
    expect(formatQuantity(1.577e11, "count")).toBe("158 B");
    expect(formatQuantity(7.9e13, "bytes")).toBe("79.0 TB");
    expect(formatQuantity(300_000, "rate")).toBe("300 k/s");
    expect(formatQuantity(60e6, "byte-rate")).toBe("60.0 MB/s");
    expect(formatQuantity(3.52e12, "count")).toBe("3.52 T");
    expect(formatQuantity(42, "count")).toBe("42.0");
  });
});
