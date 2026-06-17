import { test, expect } from "@playwright/test";
import { installAudioStub } from "./fixtures.js";

const EPUB = { name: "new-book.epub", mimeType: "application/epub+zip",
  buffer: Buffer.from("PK fake epub") };

test.describe("Upload → processing → ready", () => {
  test("adds a processing placeholder, then polls to ready", async ({ page }) => {
    await installAudioStub(page);
    let uploaded = false; let polls = 0;

    await page.route("**/ingest", (route) => {
      uploaded = true;
      return route.fulfill({ json: { job_id: "j1", book_id: "new-book", status: "processing" } });
    });
    await page.route("**/books", (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      if (!uploaded) return route.fulfill({ json: [] });
      polls += 1;
      const progress = Math.min(1, 0.3 + polls * 0.4);
      const ready = progress >= 1;
      return route.fulfill({ json: [{
        book_id: "new-book", title: "new-book", author: "",
        status: ready ? "ready" : "processing", stage: ready ? "done" : "imaging",
        progress, cover: null, scenes: 2, lines: 9,
      }] });
    });

    await page.goto("/");
    await expect(page.getByTestId("library-empty")).toBeVisible();

    await page.getByTestId("upload-input").setInputFiles(EPUB);

    // optimistic placeholder appears immediately with a spinner
    await expect(page.locator('[data-book="new-book"]')).toBeVisible();
    await expect(page.locator('[data-book="new-book"] [data-testid="spinner"]')).toBeVisible();

    // polling drives it to ready; spinner clears
    await expect(page.locator('[data-book="new-book"][data-status="ready"]'))
      .toBeVisible({ timeout: 12000 });
    await expect(page.locator('[data-book="new-book"] [data-testid="spinner"]')).toHaveCount(0);
  });

  test("the Extract-only toggle sends dry_run=true to /ingest", async ({ page }) => {
    await installAudioStub(page);
    let ingestBody = "";
    await page.route("**/books", (route) =>
      route.request().method() === "GET" ? route.fulfill({ json: [] }) : route.fallback());
    await page.route("**/ingest", (route) => {
      ingestBody = route.request().postData() || "";
      return route.fulfill({ json: { job_id: "j2", book_id: "new-book", status: "processing" } });
    });

    await page.goto("/");
    await page.getByTestId("dry-run-input").check();
    await page.getByTestId("upload-input").setInputFiles(EPUB);

    await expect.poll(() => ingestBody).toContain("dry_run");
    // multipart body carries the field value "true"
    expect(ingestBody).toMatch(/name="dry_run"[\s\S]*?true/);
  });

  test("the chosen art style (anime) is sent to /ingest", async ({ page }) => {
    await installAudioStub(page);
    let ingestBody = "";
    await page.route("**/books", (route) =>
      route.request().method() === "GET" ? route.fulfill({ json: [] }) : route.fallback());
    await page.route("**/ingest", (route) => {
      ingestBody = route.request().postData() || "";
      return route.fulfill({ json: { job_id: "j3", book_id: "new-book", status: "processing" } });
    });

    await page.goto("/");
    await page.getByTestId("upload-art-style").selectOption("anime");
    await page.getByTestId("upload-input").setInputFiles(EPUB);

    await expect.poll(() => ingestBody).toContain("art_style");
    expect(ingestBody).toMatch(/name="art_style"[\s\S]*?anime/);
  });

  test("surfaces an error if the upload fails", async ({ page }) => {
    await installAudioStub(page);
    await page.route("**/books", (route) =>
      route.request().method() === "GET" ? route.fulfill({ json: [] }) : route.fallback());
    await page.route("**/ingest", (route) => route.fulfill({ status: 500, body: "nope" }));

    await page.goto("/");
    await page.getByTestId("upload-input").setInputFiles(EPUB);
    await expect(page.getByTestId("upload-err")).toBeVisible();
  });
});
