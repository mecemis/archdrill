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

test("spreads a fleet over zones, and shows what losing one takes down", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S6 / }).click();
  await page.getByRole("tab", { name: "Load" }).click();
  await page.getByRole("tab", { name: "Peak, an availability zone lost" }).click();
  await expect(
    page.getByText(/^Redirect API: lost \d+% of its instances with a zone$/),
  ).toBeVisible();

  await page.getByTestId("node-Redirect API").click();
  const zones = page.getByRole("group", { name: "Zones" });
  await expect(zones.getByRole("button", { name: "3" })).toHaveAttribute("aria-pressed", "true");
  await zones.getByRole("button", { name: "1" }).click();

  await expect(
    page.getByText("Redirect API: down: every instance was in the lost zone"),
  ).toBeVisible();
  await expect(page.getByTestId("node-Redirect API")).toContainText("×10–120");
  await expect(page.getByTestId("node-Redirect API")).not.toContainText("AZ");
  await page.getByRole("tab", { name: /Findings/ }).click();
  await expect(
    page.getByText("Losing an availability zone takes down Redirect API", { exact: false }).first(),
  ).toBeVisible();
});

test("keeps calls in their zone, and shows what crossing zones costs", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S3 / }).click();
  // The edge moves while the nodes take their metrics; its click selects it wherever it is.
  await page.locator('.react-flow__edge[data-id="lb--redirect-api"]').dispatchEvent("click");

  const zones = page.getByRole("group", { name: "Zones" });
  const routing = zones.getByRole("checkbox", { name: /Zone-aware routing/ });
  await expect(routing).toBeChecked();
  await routing.uncheck();

  await expect(zones.getByText("Zone-aware routing would save")).toBeVisible();
  await expect(zones.getByText("67%")).toBeVisible();
  await page.getByRole("tab", { name: /Findings/ }).click();
  await expect(
    page.getByText("zone-aware routing would save", { exact: false }).first(),
  ).toBeVisible();
});
