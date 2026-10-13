import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

const require = createRequire(new URL("../packages/content/package.json", import.meta.url));
const yaml = require("yaml") as { parse(text: string): { attempt: unknown } };

test("runs under its security headers, worker included", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/.test(message.text())) violations.push(message.text());
  });
  page.on("pageerror", (error) => violations.push(error.message));

  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");

  const golden = yaml.parse(
    readFileSync(
      new URL(
        "../packages/content/problems/url-shortener/corpus/golden/postgres-redis-cache-aside.yaml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await page.getByLabel("Design file").setInputFiles({
    name: "golden.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ format: "archdrill-attempt", exportedAt: "", attempt: golden.attempt }),
    ),
  });
  await page.getByRole("button", { name: /S7 / }).click();

  await expect(page.getByTestId("scenario-score")).toHaveText("100");
  await expect(page.getByText("Updating…")).toHaveCount(0);
  expect(violations).toEqual([]);
});
