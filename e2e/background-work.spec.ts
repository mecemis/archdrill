import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

// The content package owns the YAML parser; golden designs are YAML.
const require = createRequire(new URL("../packages/content/package.json", import.meta.url));
const yaml = require("yaml") as { parse(text: string): { attempt: unknown } };

/** A golden design as the export file the app reads. */
function goldenFile(name: string) {
  const source = new URL(
    `../packages/content/problems/url-shortener/corpus/golden/${name}.yaml`,
    import.meta.url,
  );
  const { attempt } = yaml.parse(readFileSync(source, "utf8"));
  const text = JSON.stringify({
    format: "archdrill-attempt",
    exportedAt: new Date().toISOString(),
    attempt,
  });
  return { name: `${name}.json`, mimeType: "application/json", buffer: Buffer.from(text) };
}

async function importGolden(page: Page, name: string) {
  await page.goto("/");
  await page.getByLabel("Design file").setInputFiles(goldenFile(name));
  await expect(page.getByText(`Loaded ${name}.json.`)).toBeVisible();
}

test("imports a design and evaluates it in every scenario", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");

  for (const scenario of [/S1 /, /S4 /, /S5 /, /S7 /]) {
    await page.getByRole("button", { name: scenario }).click();
    await expect(page.getByTestId("scenario-score")).toHaveText("100");
  }
});

test("shows what dropping the safety scan costs, and undo brings it back", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S7 / }).click();
  await expect(page.getByTestId("scenario-score")).toHaveText("100");

  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByLabel("Operation").selectOption("create-link");
  const publish = page.getByText("Link events · publish Link created", { exact: true });
  await publish.locator("..").getByRole("button", { name: "Remove step" }).click();
  await page.getByRole("button", { name: /^…on ok:/ }).click();

  await expect(page.getByTestId("scenario-score")).toHaveText("40");
  await expect(page.getByText("Links to malicious sites are stopped")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("scenario-score")).toHaveText("100");
});

test("explains a consumer's lag and redeliveries when its dependency is down", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S7 / }).click();
  await page.getByRole("tab", { name: "Load" }).click();
  await page.getByRole("tab", { name: /URL-safety API not answering/ }).click();

  await expect(page.getByText("Scan new link · consumer")).toBeVisible();
  await expect(page.getByText(/failed messages again; after 5 deliveries/)).toBeVisible();
});
