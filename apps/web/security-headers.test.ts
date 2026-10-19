import { describe, expect, it } from "vitest";
import { headersFile, SECURITY_HEADERS } from "./security-headers";

describe("headersFile", () => {
  it("gives the static host every header the local build serves", () => {
    const file = headersFile();

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(file).toContain(`  ${name}: ${value}\n`);
    }
    expect(file).toMatch(/^\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/m);
  });

  it("keeps the policy strict: nothing from other origins, no inline scripts", () => {
    const policy = SECURITY_HEADERS["Content-Security-Policy"] ?? "";

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self';");
    expect(policy).not.toMatch(/script-src[^;]*unsafe/);
    expect(policy).toContain("frame-ancestors 'none'");
  });
});
