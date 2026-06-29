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

  test("TTS errors don't hang playback — it still reaches the end", async ({ page }) => {
    await bootPlayer(page, { backend: { ttsStatus: 502 }, audio: { clipMs: 40 } });
    await page.getByTestId("play").click();
    await expect(page.getByTestId("progress")).toHaveAttribute(
      "data-status", "done", { timeout: 20000 });
  });

  test("library lists the catalog's books", async ({ page }) => {
    await bootLibrary(page);
    await expect(page.getByTestId("card-title").first()).toHaveText(SAMPLE_BOOK.title);
  });
});
