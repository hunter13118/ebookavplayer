import { test, expect } from "@playwright/test";
import { bootPlayer } from "./fixtures.js";

test.describe("Checkpoints halt playback until acknowledged", () => {
  test("stops every N lines and resumes only on Continue", async ({ page }) => {
    // checkpoint after every 3rd line (read from localStorage at load)
    await page.addInitScript(() => localStorage.setItem("vae-checkpoint-every", "3"));
    const { ttsCalls } = await bootPlayer(page, { audio: { clipMs: 60 } });

    await page.getByTestId("play").click();

    // plays lines 0,1,2 then HALTS
    await expect.poll(() => ttsCalls.length).toBe(3);
    await expect(page.getByTestId("checkpoint")).toBeVisible();
    await expect(page.getByTestId("progress")).toHaveAttribute("data-status", "checkpoint");
    await page.waitForTimeout(600);
    expect(ttsCalls.length).toBe(3);                    // nothing fires while halted

    // acknowledge -> resumes (lines 3,4,5) then halts again
    await page.getByTestId("checkpoint").click();
    await expect.poll(() => ttsCalls.length).toBe(6);
    await expect(page.getByTestId("checkpoint")).toBeVisible();

    // final acknowledge -> finishes the book
    await page.getByTestId("checkpoint").click();
    await expect.poll(() => ttsCalls.length).toBe(9);
    await expect(page.getByTestId("progress")).toHaveAttribute(
      "data-status", "done", { timeout: 10000 });
  });
});
