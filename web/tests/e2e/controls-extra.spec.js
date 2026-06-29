import { test, expect } from "@playwright/test";
import { bootPlayer, SAMPLE_BOOK } from "./fixtures.js";

async function setSpeedControl(page, value) {
  await page.getByTestId("speed-pill").click();
  await page.getByTestId("speed-menu").getByRole("button", { name: `${value}×` }).click();
}

test.describe("Controls — remaining surfaces", () => {
  test("Speed slider persists and reaches the orchestrator", async ({ page }) => {
    await bootPlayer(page, { audio: { clipMs: 4000 } });
    await setSpeedControl(page, 1.5);
    const stored = await page.evaluate(() => localStorage.getItem("vae-speed"));
    expect(stored).toBe("1.5");
    await page.getByTestId("play").click();
    await expect.poll(() => page.evaluate(() => window.__lastRate ?? null)).toBe(1.5);
  });

  test("Speed persists across lines in auto-advance", async ({ page }) => {
    await bootPlayer(page, { audio: { clipMs: 80, durationSec: 0.08 } });
    await setSpeedControl(page, 1.5);
    await page.getByTestId("play").click();
    await expect(page.getByTestId("progress")).toHaveAttribute("data-index", "0");
    await expect.poll(() => page.getByTestId("progress").getAttribute("data-index")).toBe("1");
    await expect.poll(() => page.evaluate(() => window.__lastRate ?? null)).toBe(1.5);
  });

  test("Click-to-skip reveals the full line immediately (typewriter skip)", async ({ page }) => {
    // long duration => slow typewriter, so we can catch it mid-reveal and skip
    await bootPlayer(page, { audio: { clipMs: 9000, durationSec: 9 } });
    await page.getByTestId("play").click();
    const dialogue = page.getByTestId("dialogue");
    await dialogue.waitFor();
    // shortly after the line starts the text is still partial; click to reveal all
    await dialogue.click();
    const full = SAMPLE_BOOK.scenes[0].lines[0].text;
    await expect(page.getByTestId("dialogue-text")).toHaveText(full, { timeout: 4000 });
  });
});
