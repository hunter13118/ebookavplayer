import { test, expect } from "@playwright/test";
import {
  bootLibrary,
  bootPlayer,
  buildTestPackZip,
  clearOfflinePacks,
  minimalBook,
  TIER_AUDIOBOOK,
  TIER_VISUAL,
} from "./fixtures.js";

const PACK_BOOK = minimalBook({
  book_id: "pack-e2e",
  title: "Pack E2E Book",
  scenes: [{
    id: "s1",
    title: "One",
    background: "/media/pack-e2e/anime/bg.png",
    present: [{ character_id: "narrator", name: "Narrator" }],
    lines: [{
      idx: 0,
      text: "Offline line one.",
      character_id: "narrator",
      voice: "en-US-AndrewMultilingualNeural",
    }],
  }],
});

const CATALOG = [{
  book_id: PACK_BOOK.book_id,
  title: PACK_BOOK.title,
  author: "E2E",
  status: "ready",
  stage: "done",
  progress: 1,
  cover: null,
  scenes: 1,
  lines: 1,
  server_available: true,
}];

test.describe("Library chrome", () => {
  test("shows toolbar with add and settings", async ({ page }) => {
    await bootLibrary(page, { backend: { catalog: CATALOG, detail: PACK_BOOK } });
    await expect(page.getByTestId("library-toolbar")).toBeVisible();
    await expect(page.getByTestId("library-add")).toBeVisible();
    await expect(page.getByTestId("open-settings")).toBeVisible();
    await expect(page.getByTestId("library-shelves")).toBeVisible();
  });
});

test.describe("Implicit cache + download prompt", () => {
  test.beforeEach(async ({ page }) => {
    await clearOfflinePacks(page);
  });

  test("opening a cloud book caches and shows save modal", async ({ page }) => {
    await bootLibrary(page, {
      backend: {
        catalog: CATALOG,
        detail: PACK_BOOK,
        packBook: PACK_BOOK,
        packTier: TIER_VISUAL,
      },
    });
    await page.locator('[data-book="pack-e2e"]').click();
    await expect(page.getByTestId("download-recommend-modal")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("download-recommend-skip").click();
    await expect(page.getByTestId("progress")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("back").click();
    await expect(page.getByTestId("card-sources").first()).toContainText("This device");
  });

  test("imports multiple .vaepack files via add sheet", async ({ page }) => {
    await bootLibrary(page, { backend: { booksStatus: "fail" } });
    await page.getByTestId("library-add").click();
    const zipA = buildTestPackZip({ book: minimalBook({ book_id: "multi-a", title: "Multi A" }) });
    const zipB = buildTestPackZip({ book: minimalBook({ book_id: "multi-b", title: "Multi B" }) });
    await page.getByTestId("offline-import").setInputFiles([
      { name: "a.vaepack", mimeType: "application/zip", buffer: Buffer.from(zipA) },
      { name: "b.vaepack", mimeType: "application/zip", buffer: Buffer.from(zipB) },
    ]);
    await expect(page.getByTestId("library-toast")).toContainText(/2 pack/i, { timeout: 10_000 });
    await expect(page.getByTestId("book-card")).toHaveCount(2);
  });
});

test.describe("Selection mode bulk actions", () => {
  test.beforeEach(async ({ page }) => {
    await clearOfflinePacks(page);
  });

  test("select mode downloads vaepack for cached book", async ({ page }) => {
    await bootLibrary(page, {
      backend: {
        catalog: CATALOG,
        detail: PACK_BOOK,
        packBook: PACK_BOOK,
      },
    });
    await page.locator('[data-book="pack-e2e"]').click();
    await page.getByTestId("download-recommend-skip").click();
    await page.getByTestId("back").click();
    await page.getByTestId("library-select").click();
    await page.locator('[data-book="pack-e2e"]').click();
    await expect(page.getByTestId("bulk-download")).toBeEnabled();
    await page.getByTestId("bulk-download").click();
    await expect(page.getByTestId("library-toast")).toContainText(/Downloaded|pack/i, { timeout: 15_000 });
  });
});

test.describe("Offline pack playback", () => {
  test.beforeEach(async ({ page }) => {
    await clearOfflinePacks(page);
  });

  test("opens book from cache when server detail fails", async ({ page }) => {
    await bootLibrary(page, {
      backend: {
        catalog: CATALOG,
        detail: PACK_BOOK,
        packBook: PACK_BOOK,
      },
    });
    await page.locator('[data-book="pack-e2e"]').click();
    await page.getByTestId("download-recommend-skip").click();
    await expect(page.getByTestId("progress")).toBeVisible();

    await page.getByTestId("back").click();
    await page.route("**/books/pack-e2e", (route) => route.abort());
    await page.locator('[data-book="pack-e2e"]').click();
    await expect(page.getByTestId("progress")).toBeVisible();
    await page.getByTestId("play").click();
    await expect(page.getByTestId("dialogue-text")).toContainText("Offline line one.", { timeout: 10_000 });
  });

  test("audiobook pack plays without /tts when server is down", async ({ page }) => {
    const { ttsCalls } = await bootPlayer(page, {
      openBook: false,
      backend: {
        catalog: CATALOG,
        detail: PACK_BOOK,
        packBook: PACK_BOOK,
        packTier: TIER_AUDIOBOOK,
      },
    });
    await page.locator('[data-book="pack-e2e"]').click();
    await page.getByTestId("download-recommend-skip").click();
    await expect(page.getByTestId("progress")).toBeVisible({ timeout: 20_000 });

    await page.route("**/tts", (route) => route.abort("failed"));
    await page.getByTestId("back").click();
    await page.locator('[data-book="pack-e2e"]').click();
    await expect(page.getByTestId("progress")).toBeVisible();
    await page.getByTestId("play").click();
    await page.waitForTimeout(120);
    expect(ttsCalls.length).toBe(0);
  });
});

test.describe("Offline pack server errors", () => {
  test.beforeEach(async ({ page }) => {
    await clearOfflinePacks(page);
  });

  test("surfaces cache failure on open", async ({ page }) => {
    await bootLibrary(page, {
      backend: {
        catalog: CATALOG,
        detail: PACK_BOOK,
        packStatus: 500,
      },
    });
    await page.locator('[data-book="pack-e2e"]').click();
    await expect(page.getByTestId("note")).toContainText(/Couldn't cache|HTTP 500/i, { timeout: 15_000 });
  });
});
