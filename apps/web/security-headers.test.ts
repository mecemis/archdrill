import { describe, expect, it } from "vitest";
import { metaPolicy, SECURITY_HEADERS } from "./security-headers";

describe("SECURITY_HEADERS", () => {
  it("keeps the policy strict: nothing from other origins, no inline scripts", () => {
    const policy = SECURITY_HEADERS["Content-Security-Policy"] ?? "";

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self';");
    expect(policy).not.toMatch(/script-src[^;]*unsafe/);
    expect(policy).toContain("frame-ancestors 'none'");
  });
});

describe("metaPolicy", () => {
  it("keeps every directive a <meta> element can carry, and drops frame-ancestors", () => {
    const policy = metaPolicy();

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("worker-src 'self'");
    expect(policy).not.toContain("frame-ancestors");
    expect(policy.split("; ")).toHaveLength(
      (SECURITY_HEADERS["Content-Security-Policy"] ?? "").split("; ").length - 1,
    );
  });
});
