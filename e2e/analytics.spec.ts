import { expect, test } from "@playwright/test";
import { importGolden } from "./golden";

test("counts clicks without touching the redirect path", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S8 / }).click();

  await expect(page.getByTestId("scenario-score")).toHaveText("100");
});

test("shows what writing every click costs a viral link", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S8 / }).click();
  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByLabel("Operation").selectOption("record-click");

  await page.getByRole("button", { name: "Edit this step's settings" }).click();
  const settings = page.getByTestId("step-settings");
  await settings.getByLabel(/Aggregation window/).fill("");
  await settings.getByLabel(/Batch size/).fill("1");
  await settings.getByRole("button", { name: "Apply" }).click();

  await expect(page.getByTestId("scenario-score")).not.toHaveText("100");
  await expect(page.getByText("A viral link's clicks are all counted")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("scenario-score")).toHaveText("100");
});

test("checks back-of-envelope estimates", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Estimate" }).click();
  const question = page.getByLabel("How many links exist after five years?");

  await question.fill("160 billion");
  await question.press("Enter");

  await expect(page.getByText("Spot on", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show how" }).click();
  await expect(page.getByText(/365 days × 5 years/)).toBeVisible();
});
