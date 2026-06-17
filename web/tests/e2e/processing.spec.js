import { test, expect } from "@playwright/test";
import { bootPlayer, PROCESSING_BOOK, EXPECTED_LINES } from "./fixtures.js";

const PROC_CATALOG = [{
  book_id: PROCESSING_BOOK.book_id, title: PROCESSING_BOOK.title, author: "",
  status: "processing", stage: "imaging", progress: 0.5, cover: null,
  scenes: 2, lines: 9,
}];

test.describe("Open a book while it's still processing", () => {
  test("shows the top processing bar and plays the already-available lines", async ({ page }) => {
    const { ttsCalls } = await bootPlayer(page, {
      backend: { catalog: PROC_CATALOG, detail: PROCESSING_BOOK },
    });
    await expect(page.getByTestId("processing-bar")).toBeVisible();
    await expect(page.getByTestId("processing-bar")).toHaveAttribute("data-stage", "imaging");
    // lines are playable even though art is still generating
    await page.getByTestId("play").click();
    await expect.poll(() => ttsCalls.length).toBeGreaterThanOrEqual(2);
    expect(ttsCalls[0].voice).toBe(EXPECTED_LINES[0].voice);
  });

  test("progress climbs via polling and the bar clears when done", async ({ page }) => {
    // detail handler ramps progress on each poll, then flips to ready (no bar)
    const detail = (n) => ({
      ...PROCESSING_BOOK,
      stage: n >= 3 ? "done" : "imaging",
      progress: n >= 3 ? 1 : Math.min(0.9, 0.4 + n * 0.2),
    });
    await bootPlayer(page, { backend: { catalog: PROC_CATALOG, detail } });
    await expect(page.getByTestId("processing-bar")).toBeVisible();
    // after a couple of 2s polls, processing completes and the bar disappears
    await expect(page.getByTestId("processing-bar")).toHaveCount(0, { timeout: 12000 });
  });
});
