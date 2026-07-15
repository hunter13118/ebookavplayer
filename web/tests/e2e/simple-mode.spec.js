import { test, expect } from "@playwright/test";
import { bootLibrary, CATALOG, SAMPLE_BOOK } from "./fixtures.js";

const MIXED = [
  ...CATALOG,
  { book_id: "cooking", title: "Still Cooking", author: "Y", status: "processing",
    stage: "imaging", progress: 0.2, cover: null, scenes: 3, lines: 12, server_available: true },
];

test.describe("Simple Mode", () => {
  test("boots simple by default", async ({ page }) => {
    await bootLibrary(page, { backend: { catalog: MIXED }, prefs: { uiMode: "simple" } });
    await expect(page.getByTestId("simple-library")).toBeVisible();
    await expect(page.getByTestId("library-toolbar")).toHaveCount(0);
  });

  test("book list is plain: title + Play/Continue, processing book disabled", async ({ page }) => {
    await bootLibrary(page, { backend: { catalog: MIXED }, prefs: { uiMode: "simple" } });
    const books = page.getByTestId("simple-book");
    await expect(books).toHaveCount(2);
    const ready = books.filter({ hasNotText: "Still Cooking" });
    await expect(ready).toContainText("Play");
    const processing = page.locator(".vae-simple-book-processing");
    await expect(processing).toBeDisabled();
    await expect(processing).toContainText("Getting your book ready");
  });

  test("continue reading card: shows the in-progress book + chapter, opens the player", async ({ page }) => {
    const withResume = [
      { ...CATALOG[0], resume: { line: 12, chapter: 2, total: 100, updated: Date.now() } },
    ];
    await bootLibrary(page, {
      backend: { catalog: withResume, detail: SAMPLE_BOOK, packBook: SAMPLE_BOOK },
      prefs: { uiMode: "simple" },
    });
    const card = page.getByTestId("simple-continue-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Continue reading");
    await expect(card).toContainText("Chapter 2");
    await card.click();
    const skip = page.getByTestId("download-recommend-skip");
    if (await skip.isVisible({ timeout: 20_000 }).catch(() => false)) await skip.click();
    await expect(page.getByTestId("player-dock")).toBeVisible();
  });

  test("no continue reading card when nothing is in progress", async ({ page }) => {
    await bootLibrary(page, { backend: { catalog: CATALOG }, prefs: { uiMode: "simple" } });
    await expect(page.getByTestId("simple-continue-card")).toHaveCount(0);
  });

  test("open and play: chapter dropdown and illustration button are absent", async ({ page }) => {
    await bootLibrary(page, {
      backend: { catalog: CATALOG, detail: SAMPLE_BOOK, packBook: SAMPLE_BOOK },
      prefs: { uiMode: "simple" },
    });
    await page.getByTestId("simple-book").first().click();
    const skip = page.getByTestId("download-recommend-skip");
    if (await skip.isVisible({ timeout: 20_000 }).catch(() => false)) await skip.click();
    await expect(page.getByTestId("player-dock")).toBeVisible();
    await expect(page.getByTestId("chapter-select")).toHaveCount(0);
    await expect(page.getByTestId("show-illustration")).toHaveCount(0);
  });

  test("play/pause/back work", async ({ page }) => {
    await bootLibrary(page, {
      backend: { catalog: CATALOG, detail: SAMPLE_BOOK, packBook: SAMPLE_BOOK },
      audio: { clipMs: 4000 },
      prefs: { uiMode: "simple" },
    });
    await page.getByTestId("simple-book").first().click();
    const skip = page.getByTestId("download-recommend-skip");
    if (await skip.isVisible({ timeout: 20_000 }).catch(() => false)) await skip.click();
    await expect(page.getByTestId("player-dock")).toBeVisible();
    await page.getByTestId("play").click();
    await expect(page.getByTestId("pause")).toBeVisible();
    await page.getByTestId("pause").click();
    await expect(page.getByTestId("play")).toBeVisible();
    await page.getByTestId("back").click();
    await expect(page.getByTestId("simple-library")).toBeVisible();
  });

  test("no jargon in simple library or simple settings", async ({ page }) => {
    await bootLibrary(page, { backend: { catalog: MIXED }, prefs: { uiMode: "simple" } });
    const libText = await page.getByTestId("simple-library").innerText();
    expect(libText).not.toMatch(/backend|offline pack|provider|ingest|extraction/i);

    await page.getByTestId("simple-open-settings").click();
    const settingsText = await page.getByTestId("simple-settings").innerText();
    expect(settingsText).not.toMatch(/backend|offline pack|provider|ingest|extraction/i);
  });

  test("escape hatch: show advanced options flips to Full Mode and persists", async ({ page }) => {
    await bootLibrary(page, { backend: { catalog: CATALOG }, prefs: { uiMode: "simple" } });
    await page.getByTestId("simple-open-settings").click();
    await page.getByTestId("simple-show-advanced").click();
    await expect(page.getByTestId("library-toolbar")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("library-toolbar")).toBeVisible();
  });
});
