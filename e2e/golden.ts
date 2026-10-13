import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page } from "@playwright/test";

// The content package owns the YAML parser; golden designs are YAML.
const require = createRequire(new URL("../packages/content/package.json", import.meta.url));
const yaml = require("yaml") as { parse(text: string): { attempt: unknown } };

/** A golden design as the export file the app reads. */
export function goldenFile(name: string, problem: string) {
  const source = new URL(
    `../packages/content/problems/${problem}/corpus/golden/${name}.yaml`,
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

export async function importGolden(page: Page, name: string, problem = "url-shortener") {
  await page.goto(`/?problem=${problem}`);
  await page.getByLabel("Design file").setInputFiles(goldenFile(name, problem));
  await expect(page.getByText(`Loaded ${name}.json.`)).toBeVisible();
}
