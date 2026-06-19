import { test, expect } from "@playwright/test";
import { bootPlayer } from "./fixtures.js";

test.describe("Illustration flash", () => {
  test("shows insert overlay when line has illustration_url", async ({ page }) => {
    await bootPlayer(page);
    await page.getByTestId("play").click();
    await expect(page.getByTestId("illustration-flash")).toBeVisible({ timeout: 3000 });
    await expect(page.getByTestId("sprite").first()).toBeVisible();
    await page.waitForTimeout(4800);
    await expect(page.getByTestId("illustration-flash")).not.toBeVisible();
  });
});
