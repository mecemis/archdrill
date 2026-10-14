import { expect, test } from "@playwright/test";
import { importGolden } from "./golden";

test("follows the system theme until one is chosen, and remembers the choice", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "Theme: follows the system" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: "Theme: light" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Theme: dark" }).click();
  await expect(page.getByRole("button", { name: "Theme: follows the system" })).toBeVisible();
});

test("collapses panels to give the canvas room, and finds components by name", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("complementary", { name: "Brief" })).toBeVisible();

  await page.getByRole("tab", { name: "Brief" }).click();
  await expect(page.getByRole("complementary", { name: "Brief" })).toBeHidden();

  await page.getByRole("tab", { name: "Components" }).click();
  await page.getByLabel("Search components").fill("redis");
  await expect(page.getByRole("button", { name: "Redis", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "PostgreSQL", exact: true })).toBeHidden();

  await page.getByRole("button", { name: "Hide the flow and inspector" }).click();
  await expect(page.getByRole("tab", { name: "Flow" })).toBeHidden();
  await page.getByRole("button", { name: "Show the flow and inspector" }).click();
  await expect(page.getByRole("tab", { name: "Flow" })).toBeVisible();
});

test("collapses the results to their score", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await expect(page.getByTestId("scenario-score")).toHaveText("100");

  await page.getByRole("button", { name: "Collapse the results" }).click();
  await expect(page.getByTestId("scenario-score")).toBeHidden();
  const results = page.getByRole("region", { name: "Results" });
  await expect(results.getByText("Excellent")).toBeVisible();

  await page.getByRole("tab", { name: "Paths" }).click();
  await expect(page.getByTestId("scenario-score")).toHaveText("100");
});
