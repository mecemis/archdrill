import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

const require = createRequire(new URL("../packages/content/package.json", import.meta.url));
const yaml = require("yaml") as { parse(text: string): { attempt: unknown } };

/** Headers `_headers` assigns to a path, in Cloudflare's format. */
function headersFor(pathname: string): Record<string, string> {
  const text = readFileSync(new URL("../apps/web/public/_headers", import.meta.url), "utf8");
  const headers: Record<string, string> = {};
  let applies = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      const pattern = line.trim().replace(/\*/g, ".*");
      applies = new RegExp(`^${pattern}$`).test(pathname);
      continue;
    }
    const separator = line.indexOf(":");
    if (applies) headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return headers;
}

test("runs under the production headers, worker included", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/.test(message.text())) violations.push(message.text());
  });
  page.on("pageerror", (error) => violations.push(error.message));
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const { pathname } = new URL(route.request().url());
    await route.fulfill({ response, headers: { ...response.headers(), ...headersFor(pathname) } });
  });

  await page.goto("/");
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
