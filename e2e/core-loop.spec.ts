import { expect, type Page, test } from "@playwright/test";
import { choose } from "./flow";

async function connect(page: Page, from: string, to: string) {
  const source = page.locator(`.react-flow__node[data-id="${from}"] .react-flow__handle.source`);
  const target = page.locator(`.react-flow__node[data-id="${to}"] .react-flow__handle.target`);
  await source.dragTo(target);
  await expect(page.locator(`.react-flow__edge[data-id="${from}--${to}"]`)).toHaveCount(1);
}

test("builds a read path from an empty canvas and gets it evaluated", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    // Still a returning visitor: the welcome screen stays closed.
    localStorage.setItem("archdrill.welcomed", "1");
  });
  await page.reload();

  await page.getByRole("tab", { name: "Components" }).click();
  for (const name of ["Managed LB", "Service", "DynamoDB"]) {
    await page.getByRole("button", { name, exact: true }).click();
  }
  await connect(page, "visitors", "load-balancer-1");
  await connect(page, "load-balancer-1", "service-1");
  await connect(page, "service-1", "key-value-db-1");

  await page.locator('.react-flow__node[data-id="key-value-db-1"]').click();
  await page.getByRole("checkbox", { name: /^Link key/ }).check();
  await page.locator('.react-flow__node[data-id="service-1"]').click();
  await page.getByRole("combobox", { name: /^Size/ }).selectOption({ label: "8 vCPU" });
  const replicas = page.getByRole("slider", { name: "Replicas" });
  await replicas.fill("25");
  await replicas.blur();

  await page.getByRole("button", { name: /S2 Redirect/ }).click();
  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByRole("button", { name: "Start the flow" }).click();
  // Not found → 404, an error → 503 and expired → 410 come with the steps.
  await choose(page, "Read Link from DynamoDB");
  await choose(page, "Check expiry");
  await choose(page, "Respond 302 Found");

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
  await page.getByRole("checkbox", { name: /^Link key/ }).check();

  await page.getByRole("button", { name: /S2 Redirect/ }).click();
  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByRole("button", { name: "Start the flow" }).click();
  await choose(page, "Read Link from DynamoDB");
  await choose(page, "Respond 302 Found"); // found: redirect without checking expiry

  await expect(page.getByText("Not passing", { exact: true })).toBeVisible();
  await expect(page.getByText("Expired links never redirect")).toBeVisible();
});
