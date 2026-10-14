import { expect, type Page, test } from "@playwright/test";

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
  // One-click suggestions: the conditional insert, then each of its outcomes.
  await page.getByRole("button", { name: "Add step: PostgreSQL · insert if absent Link" }).click();
  await expect(page.getByText("PostgreSQL now stores Link.")).toBeVisible();
  for (let i = 0; i < 3; i++) {
    await page
      .getByRole("button", { name: /^Add step: Respond/ })
      .first()
      .click();
  }

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

test("answers every open error with 503 in one click", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "I'll explore on my own" }).click();
  await page.getByRole("tab", { name: "Components" }).click();
  await page.getByRole("button", { name: "Service", exact: true }).click();
  await page.getByRole("button", { name: "PostgreSQL", exact: true }).click();
  await connect(page, "visitors", "service-1");
  await connect(page, "service-1", "relational-db-1");
  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByRole("button", { name: "Start the flow" }).click();
  await page.getByRole("button", { name: "Add step: PostgreSQL · insert if absent Link" }).click();

  await page.getByRole("button", { name: "Answer the open error with 503" }).click();

  await expect(page.getByText("respond 503 Service Unavailable")).toBeVisible();
  await expect(page.getByText("2 open branches left")).toBeVisible();
});
