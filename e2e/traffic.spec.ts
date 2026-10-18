import { expect, test } from "@playwright/test";
import { importGolden } from "./golden";

test("multiplies the traffic to see what breaks, without touching the score", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S2 / }).click();
  const score = page.getByTestId("scenario-score");
  await expect(score).toHaveText("100");

  await page.getByRole("button", { name: /^Traffic:/ }).click();
  const control = page.getByTestId("traffic-control");
  await control.getByRole("button", { name: "Find the breaking point" }).click();
  const answer = page.getByTestId("breaking-point");
  await expect(answer).toContainText(/It breaks at about ×[\d.]+:/);

  await control.getByRole("button", { name: "Show it" }).click();
  const banner = page.getByTestId("what-if-banner");
  await expect(banner).toContainText(/What if: ×[\d.]+ the traffic of Peak/);
  await expect(banner).not.toContainText("simulating");
  // The Load tab shows the same what-if, and the score stays the scenario's.
  await page.getByRole("tab", { name: "Load" }).click();
  await expect(page.getByTestId("load-what-if")).toBeVisible();
  await expect(score).toHaveText("100");

  await banner.getByRole("button", { name: "Back to ×1" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("load-what-if")).toHaveCount(0);
});
