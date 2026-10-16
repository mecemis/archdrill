import { expect, test } from "@playwright/test";
import { importGolden } from "./golden";

test("asks for a prediction, then shows how close it was", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S4 / }).click();
  await page.getByRole("tab", { name: "Timeline" }).click();

  const reveal = page.getByRole("button", { name: "Reveal the timeline" });
  await expect(reveal).toBeDisabled();
  await expect(page.getByRole("slider", { name: "Success rate" })).toBeHidden();
  await page.getByLabel("Over capacity").check();
  await page.getByLabel("A few seconds").check();
  await reveal.click();

  await expect(page.getByText(/You said: Over capacity\. It was: /)).toBeVisible();
  await expect(page.getByRole("slider", { name: "Success rate" })).toBeVisible();

  // Answers survive a reload; predicting again asks once more.
  await page.reload();
  await page.getByRole("button", { name: /S4 / }).click();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.getByText(/You said: Over capacity\./)).toBeVisible();
  await page.getByRole("button", { name: "Show the design at 30 seconds" }).first().click();
  await expect(page.getByTestId("canvas-moment")).toBeVisible();

  // Predicting again hides the timeline, on the canvas too.
  await page.getByRole("button", { name: "Predict again" }).click();
  await expect(page.getByRole("button", { name: "Reveal the timeline" })).toBeDisabled();
  await expect(page.getByTestId("canvas-moment")).toBeHidden();
});

test("shows the design at a moment of a timeline", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S4 / }).click();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await page.getByRole("button", { name: "Skip and show it" }).click();

  await page.getByRole("button", { name: "Show the design at 30 seconds" }).first().click();

  await expect(page.getByTestId("canvas-moment")).toContainText("at 30 s");
  const requests = page.getByRole("region", { name: "Requests at this moment" });
  await expect(requests.getByText("Requests at 30 s")).toBeVisible();
  await expect(requests.getByText("503").first()).toBeVisible();

  await page.getByRole("button", { name: "Back to the environment" }).click();
  await expect(page.getByTestId("canvas-moment")).toBeHidden();
  await expect(requests).toBeHidden();
});

test("shows a failover second by second on the S6 timeline", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S6 / }).click();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await page.getByRole("button", { name: "Skip and show it" }).click();

  await expect(page.getByRole("slider", { name: "Success rate" })).toBeVisible();
  await expect(page.getByText("Primary failing over starts (Links DB)")).toBeVisible();
  await expect(page.getByText("Primary failing over ends (Links DB)")).toBeVisible();
});

test("shows autoscaling catching up with a spreading link on the S5 timeline", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S5 / }).click();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await page.getByRole("button", { name: "Skip and show it" }).click();

  await expect(page.getByRole("slider", { name: "Running instances" })).toBeVisible();
  await expect(
    page.getByText(/Redirect API: scaling out to \d+ instances, ready at/).first(),
  ).toBeVisible();
});

test("loses a zone second by second on the S6 timeline", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S6 / }).click();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await page.getByRole("tab", { name: "A lost zone, second by second" }).click();
  await page.getByRole("button", { name: "Skip and show it" }).click();

  await expect(page.getByText("A zone goes dark starts", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Links DB failed over")).toBeVisible();
});
