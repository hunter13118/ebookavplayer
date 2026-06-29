import { test, expect } from "@playwright/test";
import { bootPlayer, SAMPLE_BOOK } from "./fixtures.js";

test.describe("Replace art sheet", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/books/*/generate-media", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      return route.fulfill({
        json: { job_id: "replace-job-1", book_id: SAMPLE_BOOK.book_id, status: "queued" },
      });
    });
    await page.route("**/ingest/replace-job-1", async (route) =>
      route.fulfill({
        json: {
          job_id: "replace-job-1",
          status: "imaging",
          stage: "imaging",
          progress: 0.5,
          banners: [],
        },
      }));
  });

    test("preview picker posts selected character ids and closes modal on start", async ({ page }) => {
    let body = null;
    let pollN = 0;
    await page.route("**/books/*/generate-media", async (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({
        json: { job_id: "replace-job-1", book_id: SAMPLE_BOOK.book_id, status: "queued" },
      });
    });
    await page.route("**/ingest/replace-job-1", async (route) => {
      pollN += 1;
      const done = pollN >= 3;
      return route.fulfill({
        json: {
          job_id: "replace-job-1",
          status: done ? "done" : "imaging",
          stage: "imaging",
          progress: done ? 1 : 0.4 + pollN * 0.15,
          banners: [],
        },
      });
    });

    await bootPlayer(page, {
      backend: {
        detail: () => ({
          ...SAMPLE_BOOK,
          stage: "done",
          progress: 1,
          status: "ready",
        }),
      },
    });

    await page.getByTestId("open-replace").click();
    await expect(page.getByTestId("replace-sheet")).toBeVisible();
    await expect(page.getByTestId("replace-art-picker")).toBeVisible();

    await page.getByTestId("replace-select-none").click();
    await page.locator('[data-art-key="char:elara"]').click();
    await page.getByTestId("replace-submit").click();

    await expect(page.getByTestId("replace-sheet")).not.toBeVisible();
    await expect(page.getByTestId("banner")).toBeVisible();
    await expect(page.getByTestId("banner")).toHaveAttribute("data-code", "regen_started");
    await expect(page.getByTestId("processing-bar")).toBeVisible();
    await expect(page.getByTestId("processing-bar")).toHaveAttribute("data-source", "job");
    expect(body).toMatchObject({
      scope: "selected",
      force_all: false,
      include_cover: false,
      character_ids: ["elara"],
    });
  });

  test("select all uses scope all", async ({ page }) => {
    let body = null;
    await page.route("**/books/*/generate-media", async (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({
        json: { job_id: "replace-job-1", book_id: SAMPLE_BOOK.book_id, status: "queued" },
      });
    });

    await bootPlayer(page);
    await page.getByTestId("open-replace").click();
    await page.getByTestId("replace-select-all").click();
    await page.getByTestId("replace-submit").click();
    await expect(page.getByTestId("replace-sheet")).not.toBeVisible();
    expect(body).toMatchObject({ scope: "all", force_all: true });
  });

  test("failed regen POST shows error banner", async ({ page }) => {
    await page.route("**/books/*/generate-media", async (route) =>
      route.fulfill({ status: 500, body: "server error" }));

    await bootPlayer(page);
    await page.getByTestId("open-replace").click();
    await page.getByTestId("replace-select-all").click();
    await page.getByTestId("replace-submit").click();

    await expect(page.getByTestId("banner")).toBeVisible();
    await expect(page.getByTestId("banner")).toHaveAttribute("data-level", "error");
    await expect(page.getByTestId("banner")).toHaveAttribute("data-code", "regen_request_failed");
    await expect(page.getByTestId("replace-sheet")).toBeVisible();
  });

  test("upload mode replaces a single picked slot", async ({ page }) => {
    let called = false;
    await page.route("**/books/*/media/upload", async (route) => {
      called = true;
      const raw = route.request().postData() || "";
      expect(raw).toMatch(/name="key"[\s\S]*elara/);
      expect(raw).toMatch(/name="kind"[\s\S]*characters/);
      return route.fulfill({ json: { kind: "characters", key: "elara", url: "/media/x.png" } });
    });

    await bootPlayer(page);
    await page.getByTestId("open-replace").click();
    await page.getByTestId("replace-mode-upload").check();
    await page.locator('[data-art-key="char:elara"]').click();
    await page.getByTestId("replace-upload-input").setInputFiles({
      name: "elara.png",
      mimeType: "image/png",
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    await page.getByTestId("replace-submit").click();
    await expect(page.getByTestId("replace-sheet")).not.toBeVisible();
    expect(called).toBe(true);
  });
});
