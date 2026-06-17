import { test, expect } from "@playwright/test";
import { bootLibrary, CATALOG, SAMPLE_BOOK } from "./fixtures.js";

test.describe("Library card resume affordance + back navigation", () => {
  test("a started book shows the reading bar + Resume chip", async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem(`vae-resume-${id}`,
        JSON.stringify({ line: 4, total: 9, sceneId: "scene-0002", chapter: 1 }));
    }, SAMPLE_BOOK.book_id);
    await bootLibrary(page);
    const card = page.locator(`[data-book="${SAMPLE_BOOK.book_id}"]`);
    await expect(card.getByTestId("reading-bar")).toBeVisible();
    await expect(card.getByTestId("resume-chip")).toBeVisible();
  });

  test("opening that book resumes at the saved line", async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem(`vae-resume-${id}`,
        JSON.stringify({ line: 4, total: 9, sceneId: "scene-0002", chapter: 1 }));
    }, SAMPLE_BOOK.book_id);
    await bootLibrary(page);
    await page.locator(`[data-book="${SAMPLE_BOOK.book_id}"]`).click();
    await expect(page.getByTestId("progress")).toHaveAttribute("data-index", "4");
  });

  test("Back returns from the player to the library", async ({ page }) => {
    await bootLibrary(page);
    await page.getByTestId("book-card").first().click();
    await expect(page.getByTestId("progress")).toBeVisible();   // in player
    await page.getByTestId("back").click();
    await expect(page.getByTestId("library")).toBeVisible();    // back at library
    await expect(page.getByTestId("book-grid")).toBeVisible();
  });
});
