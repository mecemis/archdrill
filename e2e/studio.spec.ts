import { expect, test } from "@playwright/test";
import { importGolden } from "./golden";

test("builds a flow in the studio, one lifeline at a time", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByLabel("Operation").selectOption("redirect");
  await page.getByRole("button", { name: "Open in the studio" }).click();

  const studio = page.getByTestId("flow-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByTestId("lifeline-redirect-api")).toBeVisible();
  await expect(studio.getByTestId("studio-response").first()).toBeVisible();

  // A component the service does not call yet becomes a lifeline, then a step.
  await studio.getByRole("button", { name: "Call another" }).click();
  await studio.getByRole("button", { name: "Link events" }).click();
  await studio.getByRole("button", { name: "Add a step with Link events here" }).first().click();
  const menu = page.getByTestId("place-menu");
  await expect(menu).toBeVisible();
  // Escape closes the menu first, and keeps the studio.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(studio).toBeVisible();
  await studio.getByRole("button", { name: "Add a step with Link events here" }).first().click();
  await menu.getByRole("button", { name: /^Publish Link created/ }).click();

  await expect(page.getByText("Redirect API is now connected to Link events.")).toBeVisible();
  const step = studio.getByTestId(/^studio-step-/).filter({ hasText: "publish Link created" });
  await expect(step).toHaveCount(1);

  // Choosing a step in the diagram shows it in the list beside it.
  await step.click();
  await expect(studio.locator("[data-focused]")).toContainText("Publish");

  // Another operation from the list, then back to the canvas.
  await studio
    .getByRole("navigation", { name: "Operations" })
    .getByRole("button", { name: /Create link/ })
    .click();
  await expect(studio.getByRole("banner").or(studio.locator("header")).first()).toContainText(
    "Create link",
  );
  await page.keyboard.press("Escape");
  await expect(studio).toHaveCount(0);
});

test("opens the studio from the canvas, and says where to start without a flow", async ({
  page,
}) => {
  await page.goto("/?problem=url-shortener");
  await page.getByRole("button", { name: "Open the flow studio" }).click();
  const studio = page.getByTestId("flow-studio");
  await expect(studio).toContainText("No flow yet");
  await studio.getByRole("button", { name: "Back to the canvas" }).click();
  await expect(studio).toHaveCount(0);
});

test("keeps the app behind the studio out of reach of keys and focus", async ({ page }) => {
  await importGolden(page, "postgres-redis-cache-aside");
  await page.locator('.react-flow__node[data-id="redis"]').click();
  await page.getByRole("button", { name: "Open the flow studio" }).click();
  const studio = page.getByTestId("flow-studio");
  await expect(studio).toBeVisible();
  // Focus moved into the studio.
  await expect(studio.getByRole("heading", { name: "Flow studio" })).toBeFocused();

  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
  await studio.getByRole("button", { name: "Back to the canvas" }).click();

  await expect(page.locator('.react-flow__node[data-id="redis"]')).toHaveCount(1);
});
