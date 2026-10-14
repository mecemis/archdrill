import { expect, test } from "@playwright/test";
import { importGolden } from "./golden";

test("resizes panels from the keyboard and the mouse, and remembers the sizes", async ({
  page,
}) => {
  await page.goto("/");
  const left = page.getByRole("separator", { name: "Resize the left panel" });
  const before = Number(await left.getAttribute("aria-valuenow"));

  await left.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(left).toHaveAttribute("aria-valuenow", String(before + 32));

  const results = page.getByRole("separator", { name: "Resize the results" });
  const box = await results.boundingBox();
  if (!box) throw new Error("no results handle");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 100, { steps: 5 });
  await page.mouse.up();
  const taller = Number(await results.getAttribute("aria-valuenow"));
  expect(taller).toBeGreaterThan(300);

  await page.reload();
  await expect(left).toHaveAttribute("aria-valuenow", String(before + 32));
  await expect(results).toHaveAttribute("aria-valuenow", String(taller));
});

test("folds the results to their header when dragged down far enough", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  const results = page.getByRole("separator", { name: "Resize the results" });
  const box = await results.boundingBox();
  if (!box) throw new Error("no results handle");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 400, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByTestId("scenario-score")).toBeHidden();
  await expect(page.getByRole("button", { name: "Show the results" })).toBeVisible();
});

test("badges components with their open findings and opens the finding", async ({ page }) => {
  await importGolden(page, "dynamodb-direct");
  await page.getByRole("button", { name: /S3 / }).click();
  await page.getByRole("tab", { name: "Paths" }).click();

  const badge = page.getByRole("button", { name: /open finding/ }).first();
  await expect(badge).toBeVisible();
  await badge.click();

  await expect(page.getByRole("tab", { name: /Findings/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: "Show on canvas", pressed: true })).toBeVisible();
});

test("plays a timeline on the canvas", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S4 / }).click();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await page.getByRole("button", { name: /Skip and show/ }).click();

  await page.getByRole("button", { name: "Play the timeline" }).click();
  await expect(page.getByTestId("canvas-moment")).toBeVisible();
  const moment = page.locator("input[type=range]");
  await expect.poll(async () => Number(await moment.inputValue())).toBeGreaterThan(2);
  await page.getByRole("button", { name: "Pause the timeline" }).click();
  await expect(page.getByRole("button", { name: "Play the timeline" })).toBeVisible();
});
