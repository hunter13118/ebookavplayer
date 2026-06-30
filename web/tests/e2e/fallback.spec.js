import { test, expect } from "@playwright/test";
import { bootPlayer, bootLibrary, SAMPLE_BOOK } from "./fixtures.js";

test.describe("Graceful degradation", () => {
  test("unreachable catalog falls back to the embedded demo (with a note)", async ({ page }) => {
    // /books aborts -> offline demo library; opening the card plays the sample.
    await bootPlayer(page, { backend: { booksStatus: "fail" } });
    await expect(page.getByTestId("note")).toBeVisible();
    await expect(page.getByTestId("scene-title")).toHaveText("The Gate at Dusk");
  });

  test("empty catalog shows empty library with add button", async ({ page }) => {
    await bootLibrary(page, { backend: { booksStatus: "empty" } });
    await expect(page.getByTestId("library-empty")).toBeVisible();
    await page.getByTestId("library-empty-add").click();
    await expect(page.getByTestId("uploader")).toBeVisible();
  });

  test("TTS errors halt playback instead of silently racing to the end", async ({ page }) => {
    // A hard TTS outage (502) must NOT be treated as "no audio for this line" —
    // it should stop auto-advance in place rather than simulate-and-skip through
    // the whole book. See tts-failure.spec.js for the full error-recovery flow.
    const { ttsCalls } = await bootPlayer(page, { backend: { ttsStatus: 502 }, audio: { clipMs: 40 } });
    await page.getByTestId("play").click();
    await expect(page.getByTestId("progress")).toHaveAttribute("data-status", "error", { timeout: 5000 });
    await expect(page.getByTestId("progress")).toHaveAttribute("data-index", "0");
    // Give it plenty of time beyond what the old (buggy) simulate-through-the-book
    // behavior would have needed — it must still be stuck, not "done".
    await page.waitForTimeout(3000);
    await expect(page.getByTestId("progress")).toHaveAttribute("data-status", "error");
    await expect(page.getByTestId("progress")).toHaveAttribute("data-index", "0");
    // Prefetch-ahead-of-the-failing-line is fine, but it must not have iterated
    // through every line in the book trying each one.
    expect(ttsCalls.length).toBeLessThanOrEqual(2);
  });

  test("library lists the catalog's books", async ({ page }) => {
    await bootLibrary(page);
    await expect(page.getByTestId("card-title").first()).toHaveText(SAMPLE_BOOK.title);
  });
});
