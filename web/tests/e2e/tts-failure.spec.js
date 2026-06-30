import { test, expect } from "@playwright/test";
import { bootPlayer, EXPECTED_LINES } from "./fixtures.js";

// Spec: when the TTS backend fails mid-line, auto-advance must STOP at that
// line (not simulate audio and race through the rest of the book). The user
// sees an error modal; acknowledging it switches playback to manual
// (click-through) mode so they can keep reading and we retry narration for
// each new line they navigate to.
test.describe("TTS failure handling", () => {
  test("a hard TTS failure on line 0 halts auto-advance and shows the error modal", async ({ page }) => {
    const { ttsCalls } = await bootPlayer(page, { backend: { ttsStatus: 502 }, audio: { clipMs: 40 } });

    await page.getByTestId("play").click();

    await expect(page.getByTestId("tts-error-modal")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("progress")).toHaveAttribute("data-status", "error");
    await expect(page.getByTestId("progress")).toHaveAttribute("data-index", "0");

    // Never reaches "done" — confirms it didn't race through the rest of the book.
    expect(ttsCalls.length).toBeLessThanOrEqual(2);
  });

  test("acknowledging the error switches to manual mode and retries TTS per line", async ({ page }) => {
    // Line 0 fails exactly once; every other request (including the retry) succeeds.
    let line0Attempts = 0;
    const ttsStatus = (body) => {
      if (body.text === EXPECTED_LINES[0].text) {
        line0Attempts += 1;
        return line0Attempts === 1 ? 502 : 200;
      }
      return 200;
    };

    await bootPlayer(page, { backend: { ttsStatus }, audio: { clipMs: 40 } });

    await page.getByTestId("play").click();
    await expect(page.getByTestId("tts-error-modal")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("progress")).toHaveAttribute("data-status", "error");

    await page.getByTestId("tts-error-acknowledge").click();
    await expect(page.getByTestId("tts-error-modal")).not.toBeVisible();

    // Acknowledging persists manual mode (auto-advance off).
    const autoAdvance = await page.evaluate(() => localStorage.getItem("vae-auto-advance"));
    expect(autoAdvance).toBe("false");

    // Retrying Play attempts TTS again for the SAME line (now succeeding) and,
    // since we're in manual mode, pauses after the line instead of advancing.
    await page.getByTestId("play").click();
    await expect(page.getByTestId("progress")).toHaveAttribute("data-status", "paused", { timeout: 5000 });
    await expect(page.getByTestId("progress")).toHaveAttribute("data-index", "0");

    // Clicking Next attempts TTS for the next line and pauses again, manually.
    await page.getByTestId("next").click();
    await expect(page.getByTestId("progress")).toHaveAttribute("data-status", "paused", { timeout: 5000 });
    await expect(page.getByTestId("progress")).toHaveAttribute("data-index", "1");

    expect(line0Attempts).toBe(2);
  });

  test("a TTS failure on a later line (already in manual mode) re-shows the modal", async ({ page }) => {
    await bootPlayer(page, {
      backend: { ttsStatus: (body) => (body.text === EXPECTED_LINES[1].text ? 502 : 200) },
      audio: { clipMs: 40 },
      prefs: { autoAdvance: false },
    });

    await page.getByTestId("play").click();
    await expect(page.getByTestId("progress")).toHaveAttribute("data-status", "paused", { timeout: 5000 });
    await expect(page.getByTestId("progress")).toHaveAttribute("data-index", "0");

    await page.getByTestId("next").click();
    await expect(page.getByTestId("tts-error-modal")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("progress")).toHaveAttribute("data-status", "error");
    await expect(page.getByTestId("progress")).toHaveAttribute("data-index", "1");
  });
});
