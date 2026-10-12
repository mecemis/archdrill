import { expect, type Page, test } from "@playwright/test";

async function connect(page: Page, from: string, to: string) {
  const source = page.locator(`.react-flow__node[data-id="${from}"] .react-flow__handle.source`);
  const target = page.locator(`.react-flow__node[data-id="${to}"] .react-flow__handle.target`);
  await source.dragTo(target);
  await expect(page.locator(`.react-flow__edge[data-id="${from}--${to}"]`)).toHaveCount(1);
}

async function fillNextSlot(page: Page, fill: () => Promise<void>) {
  await page.getByTestId("step-tree").getByRole("button", { name: "Add step" }).first().click();
  await fill();
  await page.getByTestId("add-step-form").getByRole("button", { name: "Add step" }).click();
}

function respond(page: Page, status: string) {
  return async () => {
    const form = page.getByTestId("add-step-form");
    await form.getByRole("button", { name: "Respond" }).click();
    await form.getByLabel("Status").selectOption(status);
  };
}

test("builds a read path from an empty canvas and gets it evaluated", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("tab", { name: "Components" }).click();
  for (const name of ["Managed LB", "Service", "DynamoDB"]) {
    await page.getByRole("button", { name, exact: true }).click();
  }
  await connect(page, "visitors", "load-balancer-1");
  await connect(page, "load-balancer-1", "service-1");
  await connect(page, "service-1", "key-value-db-1");

  await page.locator('.react-flow__node[data-id="key-value-db-1"]').click();
  await page.getByRole("checkbox", { name: /Link/ }).check();
  await page.locator('.react-flow__node[data-id="service-1"]').click();
  await page.getByLabel("Size").selectOption({ label: "8 vCPU" });
  const replicas = page.getByRole("slider", { name: "Replicas" });
  await replicas.fill("25");
  await replicas.blur();

  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByRole("button", { name: "Start the flow" }).click();
  await page.getByRole("button", { name: "Add the first step" }).click();
  await page.getByTestId("add-step-form").getByRole("button", { name: "Add step" }).click();
  await fillNextSlot(page, () =>
    page.getByTestId("add-step-form").getByRole("button", { name: "Logic" }).click(),
  );
  await fillNextSlot(page, respond(page, "302"));
  await fillNextSlot(page, respond(page, "410"));
  await fillNextSlot(page, respond(page, "404"));
  await fillNextSlot(page, respond(page, "503"));

  await expect(page.getByTestId("scenario-score")).toHaveText("100");
  await expect(page.getByText("Excellent")).toBeVisible();
});

test("points at the gate that a broken flow fails", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "Discard design" }).click();
  await page.getByRole("tab", { name: "Components" }).click();
  await page.getByRole("button", { name: "Service", exact: true }).click();
  await page.getByRole("button", { name: "DynamoDB", exact: true }).click();
  await connect(page, "visitors", "service-1");
  await connect(page, "service-1", "key-value-db-1");
  await page.locator('.react-flow__node[data-id="key-value-db-1"]').click();
  await page.getByRole("checkbox", { name: /Link/ }).check();

  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByRole("button", { name: "Start the flow" }).click();
  await page.getByRole("button", { name: "Add the first step" }).click();
  await page.getByTestId("add-step-form").getByRole("button", { name: "Add step" }).click();
  await fillNextSlot(page, respond(page, "302")); // found: redirect without checking expiry

  await expect(page.getByText("Not passing", { exact: true })).toBeVisible();
  await expect(page.getByText("Expired links never redirect")).toBeVisible();
});
