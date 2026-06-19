import { test, expect } from "@playwright/test";
import { bootPlayer, SAMPLE_BOOK } from "./fixtures.js";

test.describe("Art style switcher", () => {
  test("shows style options with status badges", async ({ page }) => {
    await bootPlayer(page);
    const sw = page.getByTestId("art-style-switcher");
    await expect(sw).toBeVisible();
    await expect(page.getByTestId("art-style-option")).toHaveCount(4);
    await expect(page.locator('[data-style="semi-real"]')).toHaveClass(/active/);
  });

  test("PATCH switches to pixel filter instantly", async ({ page }) => {
    const view = { artFilter: null, patched: null };
    await page.route("**/books/*/active-style", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      view.patched = route.request().postDataJSON();
      view.artFilter = "pixel";
      return route.fulfill({
        json: { active_style: "pixel", styles: SAMPLE_BOOK.styles },
      });
    });
    await bootPlayer(page, {
      backend: {
        detail: () => ({
          ...SAMPLE_BOOK,
          active_style: view.artFilter ? "pixel" : "semi-real",
          art_filter: view.artFilter,
        }),
      },
    });
    await page.locator('[data-style="pixel"][data-status="filter"]').click();
    expect(view.patched).toMatchObject({ style: "pixel", mode: "filter" });
    await expect(page.getByTestId("stage")).toHaveAttribute("data-pixel-filter", "true");
  });

  test("confirm modal starts style generation job", async ({ page }) => {
    let posted = false;
    await page.route("**/books/*/styles/anime", async (route) => {
      posted = true;
      return route.fulfill({ json: { job_id: "style-job-1", style: "anime", status: "queued" } });
    });
    await bootPlayer(page);
    await page.locator('[data-style="anime"][data-status="empty"]').click();
    await expect(page.getByTestId("style-generate-dialog")).toBeVisible();
    await page.getByTestId("style-generate-confirm").click();
    expect(posted).toBe(true);
  });
});
