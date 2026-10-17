import { expect, test } from "@playwright/test";
import { stepMenu } from "./flow";
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

test("keeps a standby in a second region, and shows what losing the primary takes", async ({
  page,
}) => {
  await importGolden(page, "postgres-redis-two-regions");
  await page.getByRole("button", { name: /S9 / }).click();
  await page.getByRole("tab", { name: "Load" }).click();
  await page.getByRole("tab", { name: "Peak, primary region lost" }).click();
  await expect(page.getByTestId("node-Links DB")).toContainText("standby region");

  await page.getByTestId("node-Links DB").click();
  const regions = page.getByRole("group", { name: "Regions" });
  await expect(regions.getByRole("button", { name: "+ Standby" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(regions.getByText(/takes writes once promoted, 3 minutes after/)).toBeVisible();
  await regions.getByRole("button", { name: "Primary only" }).click();

  await expect(page.getByText("Links DB: down: it ran only in the lost region")).toBeVisible();
  await expect(page.getByTestId("node-Links DB")).not.toContainText("standby region");
  await page.getByRole("tab", { name: /Findings/ }).click();
  await expect(
    page.getByText("Losing the primary region takes down", { exact: false }).first(),
  ).toBeVisible();
});

test("keeps codes unique when both regions take creates", async ({ page }) => {
  await importGolden(page, "dynamodb-redis-active-active");
  await page.getByRole("button", { name: /S9 / }).click();
  await expect(page.getByTestId("scenario-score")).toHaveText("100");
  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByLabel("Operation").selectOption("create-link");

  await stepMenu(page, "home region");
  await page.getByRole("button", { name: /^Settings/ }).click();
  const settings = page.getByTestId("step-settings");
  await settings.getByLabel(/Write in the home region/).uncheck();
  await settings.getByRole("button", { name: "Apply" }).click();

  await expect(page.getByTestId("scenario-score")).not.toHaveText("100");
  await expect(page.getByText("Codes stay unique when both regions take creates")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("scenario-score")).toHaveText("100");
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

test("publishes to a queue the service is not connected to, connecting it", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByLabel("Operation").selectOption("redirect");
  await expect(page.locator('.react-flow__edge[data-id="redirect-api--link-events"]')).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "Insert a step here" }).first().click();
  await expect(page.getByTestId("step-picker")).toBeVisible();
  // Clicking the queue on the canvas narrows the picker to its steps, connected or not.
  const queue = page.locator('.react-flow__node[data-id="link-events"]');
  await expect(queue.locator(".border-dashed")).toHaveCount(1);
  await queue.click();
  const unconnected = page.getByTestId("unconnected-steps");
  await expect(unconnected).toHaveAttribute("open", "");
  await unconnected
    .getByRole("button", { name: /^Publish/ })
    .first()
    .click();

  await expect(page.getByText("Redirect API is now connected to Link events.")).toBeVisible();
  await expect(page.locator('.react-flow__edge[data-id="redirect-api--link-events"]')).toHaveCount(
    1,
  );
  await expect(
    page
      .getByTestId(/^step-(?!picker)/)
      .filter({ hasText: /Publish/ })
      .first(),
  ).toBeVisible();
});

test("fits every instance's pools into the database, or puts a proxy in front", async ({
  page,
}) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("button", { name: /S5 / }).click();
  await expect(page.getByTestId("scenario-score")).toHaveText("100");
  await page.locator('.react-flow__edge[data-id="redirect-api--links-db"]').dispatchEvent("click");

  const pool = page.getByRole("group", { name: "Connection pool" });
  const size = pool.getByLabel("Pool size (connections to each copy)");
  await expect(size).toHaveValue("10");
  await size.fill("50");
  await size.press("Enter");

  await expect(page.getByTestId("scenario-score")).not.toHaveText("100");
  await expect(
    page.getByText("Every instance's database pools fit its connection limit at the spike"),
  ).toBeVisible();

  await page.locator('.react-flow__node[data-id="links-db"]').click();
  await page.getByRole("checkbox", { name: "Connection proxy (RDS Proxy)" }).check();
  await expect(page.getByTestId("scenario-score")).toHaveText("100");
  await expect(
    page.locator('.react-flow__node[data-id="links-db"]').getByText("proxy"),
  ).toBeVisible();
});

test("adds steps on the canvas, carrying on behind each one", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByLabel("Operation").selectOption("redirect");

  await page.getByRole("button", { name: "Add steps on the canvas" }).click();
  const bar = page.getByTestId("cursor-bar");
  await expect(bar).toContainText("Redirect: adding before responding");

  const queue = page.locator('.react-flow__node[data-id="link-events"]');
  await expect(queue.locator(".border-dashed")).toHaveCount(1);
  await queue.click();
  const menu = page.getByTestId("step-menu");
  await expect(menu).toBeVisible();
  // Escape closes the menu first, and keeps adding.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(bar).toBeVisible();
  await queue.click();
  await expect(menu).toContainText("Not connected yet");
  await menu
    .getByRole("button", { name: /^Publish/ })
    .first()
    .click();

  await expect(page.getByText("Redirect API is now connected to Link events.")).toBeVisible();
  await expect(menu).toHaveCount(0);
  // The cursor moved behind the new step, still armed for the next click.
  await expect(bar).toContainText("Link events · publish");
  await bar.getByRole("button", { name: "Done" }).click();
  await expect(bar).toHaveCount(0);

  // The new step's number on the canvas brings it into view in the list.
  await page
    .getByRole("button", { name: /^Show step \d+ in the flow$/ })
    .last()
    .click();
  await expect(page.locator("[data-focused]")).toContainText("Publish");
});
