import { test, expect } from "@playwright/test";
import { bootLibrary, SAMPLE_BOOK } from "./fixtures.js";

const MIXED = [
  { book_id: "ready-one", title: "A Ready Book", author: "X", status: "ready",
    stage: "done", progress: 1, cover: "gradient:255,210", scenes: 2, lines: 9 },
  { book_id: "cooking", title: "Still Cooking", author: "Y", status: "processing",
    stage: "imaging", progress: 0.45, cover: null, scenes: 3, lines: 12 },
];

test.describe("Library landing", () => {
  test("renders a card per book with the real title beneath", async ({ page }) => {
    await bootLibrary(page, { backend: { catalog: MIXED } });
    await expect(page.getByTestId("book-card")).toHaveCount(2);
    await expect(page.locator('[data-book="ready-one"] [data-testid="card-title"]'))
      .toHaveText("A Ready Book");
    await expect(page.locator('[data-book="cooking"] [data-testid="card-title"]'))
      .toHaveText("Still Cooking");
  });

  test("processing book shows a spinner + progress; ready book shows a cover", async ({ page }) => {
    await bootLibrary(page, { backend: { catalog: MIXED } });
    await expect(page.locator('[data-book="cooking"] [data-testid="spinner"]')).toBeVisible();
    await expect(page.locator('[data-book="cooking"] [data-testid="card-progress"]'))
      .toHaveAttribute("data-progress", "45");
    await expect(page.locator('[data-book="ready-one"] [data-testid="spinner"]')).toHaveCount(0);
  });

  test("clicking a ready book opens the player", async ({ page }) => {
    await bootLibrary(page, { backend: { catalog: MIXED, detail: SAMPLE_BOOK } });
    await page.locator('[data-book="ready-one"]').click();
    await expect(page.getByTestId("progress")).toBeVisible();
    await expect(page.getByTestId("back")).toBeVisible();
  });
});
