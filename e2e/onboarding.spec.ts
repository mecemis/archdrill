import { expect, type Page, test } from "@playwright/test";
import { choose } from "./flow";

// A first visit: nothing remembered yet.
test.use({ storageState: { cookies: [], origins: [] } });

async function connect(page: Page, from: string, to: string) {
  await page
    .locator(`.react-flow__node[data-id="${from}"] .react-flow__handle.source`)
    .dragTo(page.locator(`.react-flow__node[data-id="${to}"] .react-flow__handle.target`));
}

test("welcomes a first visit and guides it from an empty canvas to a score", async ({ page }) => {
  await page.goto("/");
  const welcome = page.getByRole("dialog", { name: "Welcome to ArchDrill" });
  await expect(welcome).toBeVisible();
  await welcome.getByRole("button", { name: "Guide me through the first scenario" }).click();
  await expect(welcome).toBeHidden();

  const guide = page.getByRole("region", { name: "Getting started" });
  await expect(guide).toContainText("0/6");
  await guide.getByRole("button", { name: "Show me" }).click();
  await expect(page.getByRole("status")).toContainText("Click Service to add it");

  await page.getByRole("button", { name: "Service", exact: true }).click();
  await page.getByRole("button", { name: "PostgreSQL", exact: true }).click();
  await connect(page, "visitors", "service-1");
  await connect(page, "service-1", "relational-db-1");
  await expect(guide).toContainText("2/6");

  await guide.getByRole("button", { name: "Show me" }).click();
  await page.getByRole("button", { name: "Start the flow" }).click();
  // A conflict answers 409 and an error 503 by default; success needs a response.
  await choose(page, "Write Link to PostgreSQL if its key is free");
  await expect(page.getByText("PostgreSQL now stores Link.")).toBeVisible();
  await choose(page, "Respond 201 Created");

  await expect(page.getByTestId("scenario-score")).toBeVisible();
  await expect(guide).toContainText("6/6");

  await page.reload();
  await expect(page.getByRole("dialog", { name: "Welcome to ArchDrill" })).toBeHidden();
});

test("opens an example design from the help menu, and undo brings the own design back", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "I'll explore on my own" }).click();

  await page.getByRole("button", { name: "Help" }).click();
  await page.getByRole("menuitem", { name: /PostgreSQL with a Redis cache/ }).click();

  await expect(page.getByText(/Opened the example "PostgreSQL with a Redis cache"/)).toBeVisible();
  await expect(page.getByTestId("scenario-score")).toHaveText("100");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Waiting for flows")).toBeVisible();
});
