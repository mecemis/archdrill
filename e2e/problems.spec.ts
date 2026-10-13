import { expect, test } from "@playwright/test";
import { importGolden } from "./golden";

test("switches problems, each with its own design", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Problem")).toHaveValue("url-shortener");

  await page.getByLabel("Problem").selectOption("rate-limiter");
  await expect(page).toHaveURL(/problem=rate-limiter/);
  await expect(page.getByRole("button", { name: /S1 Enforce limits/ })).toBeVisible();
  await expect(page.getByText("API clients", { exact: true }).first()).toBeVisible();
});

test("passes every rate limiter scenario with a shared counter and a block marker", async ({
  page,
}) => {
  await importGolden(page, "redis-sliding-counter", "rate-limiter");

  for (const scenario of [/S1 /, /S2 /, /S3 /]) {
    await page.getByRole("button", { name: scenario }).click();
    await expect(page.getByTestId("scenario-score")).toHaveText("100");
  }
});

test("shows a runaway client saturating the shard that counts it", async ({ page }) => {
  await importGolden(page, "redis-sliding-counter", "rate-limiter");
  await page.getByRole("button", { name: /S3 / }).click();
  await page.getByRole("tab", { name: "Flow" }).click();

  // Count every request in Redis again, rejected or not.
  await page
    .getByText("Local state · get Block", { exact: true })
    .locator("..")
    .getByRole("button", { name: "Remove step" })
    .click();
  await page.getByRole("button", { name: /^…on miss:/ }).click();

  await expect(page.getByTestId("scenario-score")).not.toHaveText("100");
  await expect(page.getByText("Nothing runs above 85% with a runaway client")).toBeVisible();
});

test("passes every news feed scenario with a hybrid fan-out", async ({ page }) => {
  await importGolden(page, "hybrid-fan-out", "news-feed");

  for (const scenario of [/S1 /, /S2 /, /S3 /]) {
    await page.getByRole("button", { name: scenario }).click();
    await expect(page.getByTestId("scenario-score")).toHaveText("100");
  }
});

test("passes every chat scenario with gateways sized for connections", async ({ page }) => {
  await importGolden(page, "gateways-and-sequences", "chat");

  for (const scenario of [/S1 /, /S2 /, /S3 /]) {
    await page.getByRole("button", { name: scenario }).click();
    await expect(page.getByTestId("scenario-score")).toHaveText("100");
  }
});

test("passes every payments scenario with an outbox and a saga", async ({ page }) => {
  await importGolden(page, "outbox-saga", "payments");

  for (const scenario of [/S1 /, /S2 /, /S3 /]) {
    await page.getByRole("button", { name: scenario }).click();
    await expect(page.getByTestId("scenario-score")).toHaveText("100");
  }
});
