import { expect, test } from "@playwright/test";
import { stepMenu } from "./flow";
import { importGolden } from "./golden";

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
  await stepMenu(page, "Publish Link created to Link events");
  await page.getByRole("button", { name: "Remove step" }).click();

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
