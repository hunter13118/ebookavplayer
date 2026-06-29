import { test, expect } from "@playwright/test";
import { bootPlayer, EXPECTED_LINES } from "./fixtures.js";

test.describe("Controls gate invocation", () => {
  test("Pause stops any further /tts calls", async ({ page }) => {
    const { ttsCalls } = await bootPlayer(page, { audio: { clipMs: 120 } });
    await page.getByTestId("play").click();
    await expect.poll(() => ttsCalls.length).toBeGreaterThanOrEqual(2);
    await page.getByTestId("pause").click();
    const frozen = ttsCalls.length;
    await page.waitForTimeout(800);
    expect(ttsCalls.length).toBe(frozen);             // nothing fired after pause
    await expect(page.getByTestId("play")).toBeVisible(); // back to Play state
  });

  test("Next cancels the in-flight line and advances to the next (no dup)", async ({ page }) => {
    // Long clip keeps line 0 in-flight so we can interrupt it deterministically.
    const { ttsCalls } = await bootPlayer(page, { audio: { clipMs: 4000 } });
    await page.getByTestId("play").click();
    await expect.poll(() => ttsCalls.length).toBe(1);   // narrator playing
    await page.getByTestId("next").click();
    await expect.poll(() => ttsCalls.length).toBe(2);   // jumped straight to line 1
    expect(ttsCalls[0].voice).toBe(EXPECTED_LINES[0].voice); // narrator (once)
    expect(ttsCalls[1].voice).toBe(EXPECTED_LINES[1].voice); // Elara, not narrator again
  });

  test("Restart replays from line 0 and cancels the prior run", async ({ page }) => {
    const { ttsCalls } = await bootPlayer(page, { audio: { clipMs: 120 } });
    await page.getByTestId("play").click();
    await expect.poll(() => ttsCalls.length).toBeGreaterThanOrEqual(2);
    await page.getByTestId("restart").click();
    await expect(page.getByTestId("progress")).toHaveAttribute(
      "data-status", "done", { timeout: 20000 });
    const total = EXPECTED_LINES.length;
    // the prior run was cancelled, not run to completion in parallel:
    expect(ttsCalls.length).toBeLessThan(total * 2);
    // and the final full pass matches the expected per-character order:
    const tail = ttsCalls.slice(-total).map((c) => c.voice);
    expect(tail).toEqual(EXPECTED_LINES.map((l) => l.voice));
  });
});
