import type { Page } from "@playwright/test";

/** Chooses a step in the open step picker by what it does. */
export async function choose(page: Page, name: string | RegExp) {
  await page.getByTestId("step-picker").getByRole("button", { name, exact: true }).first().click();
}

/** Opens the options menu of the step card that says this. */
export async function stepMenu(page: Page, says: string | RegExp) {
  await page
    .getByTestId(/^step-(?!picker)/)
    .filter({ hasText: says })
    .first()
    .getByRole("button", { name: "Step options" })
    .click();
}
