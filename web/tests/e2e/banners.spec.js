import { test, expect } from "@playwright/test";
import { bootPlayer, SAMPLE_BOOK } from "./fixtures.js";

test.describe("Imaging banners", () => {
  test("banner stack shows Gemini fallback and failure messages", async ({ page }) => {
    const bookWithBanners = {
      ...SAMPLE_BOOK,
      banners: [
        {
          id: "e2e-fallback",
          level: "info",
          code: "gemini_image_fallback",
          message: "Gemini image model gemini-2.5-flash-image unavailable — trying gemini-3.1-flash-image.",
          ts: Date.now() / 1000,
        },
        {
          id: "e2e-fail",
          level: "error",
          code: "imaging_zero",
          message: "No images were generated. Upload art manually or start War Council local SD.",
          ts: Date.now() / 1000,
        },
      ],
    };
    await bootPlayer(page, {
      audio: { clipMs: 4000 },
      backend: { detail: bookWithBanners },
    });
    const stack = page.getByTestId("banner-stack");
    await expect(stack).toBeVisible();
    await expect(page.getByTestId("banner").first()).toContainText("Gemini image model");
    await expect(page.getByTestId("banner").nth(1)).toContainText("No images were generated");
    await page.getByTestId("banner").first().locator(".vae-banner-dismiss").click();
    await expect(page.getByTestId("banner")).toHaveCount(1);
  });

  test("banners auto-fade after a few seconds", async ({ page }) => {
    await page.addInitScript(() => {
      window.__VAE_TEST_BANNER_MS = 400;
    });
    const bookWithBanners = {
      ...SAMPLE_BOOK,
      banners: [
        {
          id: "e2e-auto",
          level: "info",
          code: "freemium_fallback",
          message: "Using free image API fallback.",
          ts: Date.now() / 1000,
        },
      ],
    };
    await bootPlayer(page, {
      audio: { clipMs: 4000 },
      backend: { detail: bookWithBanners },
    });
    await expect(page.getByTestId("banner-stack")).toBeVisible();
    await page.waitForTimeout(700);
    await expect(page.getByTestId("banner-stack")).not.toBeVisible();
  });
});
