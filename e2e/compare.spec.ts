import { expect, test } from "@playwright/test";
import { goldenFile, importGolden } from "./golden";

test("compares the design with another design file in every scenario", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("tab", { name: "Compare" }).click();

  await page
    .getByLabel("Design to compare with")
    .setInputFiles(goldenFile("dynamodb-direct", "url-shortener"));

  await expect(page.getByTestId("compare-source")).toHaveText(
    "Comparing with dynamodb-direct.json.",
  );
  const s3 = page.getByRole("row", { name: /S3 Cache the hot path/ });
  // The design without a cache does not pass S3; the current one does.
  await expect(s3.getByRole("cell").nth(2)).toHaveText("100");
  await expect(s3.getByRole("cell").nth(3)).toHaveText(/^\+\d+$/);
  await expect(page.getByRole("columnheader", { name: "Cost now" })).toBeVisible();
});
