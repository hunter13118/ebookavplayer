import { test, expect } from "@playwright/test";
import { bootPlayer, SAMPLE_BOOK, EXPECTED_LINES } from "./fixtures.js";

test.describe("Resume position", () => {
  test("opening a book jumps to the saved line", async ({ page }) => {
    // pre-seed a resume position in localStorage before the app loads
    await page.addInitScript((id) => {
      localStorage.setItem(`vae-resume-${id}`,
        JSON.stringify({ line: 3, sceneId: "scene-0001", chapter: 1, total: 9 }));
    }, SAMPLE_BOOK.book_id);

    await bootPlayer(page);
    await expect(page.getByTestId("progress")).toHaveAttribute("data-index", "3");
  });

  test("playback persists the position as it advances", async ({ page }) => {
    await bootPlayer(page, { audio: { clipMs: 60 } });
    await page.getByTestId("play").click();
    // wait until a few lines have played
    await expect(page.getByTestId("progress")).toHaveAttribute("data-index", "2", { timeout: 10000 });
    const saved = await page.evaluate((id) =>
      JSON.parse(localStorage.getItem(`vae-resume-${id}`) || "{}"), SAMPLE_BOOK.book_id);
    expect(saved.line).toBeGreaterThanOrEqual(2);
    expect(saved.total).toBe(EXPECTED_LINES.length);
  });

  test("fresh book with no saved position starts at line 0", async ({ page }) => {
    await bootPlayer(page);
    await expect(page.getByTestId("progress")).toHaveAttribute("data-index", "0");
  });
});
