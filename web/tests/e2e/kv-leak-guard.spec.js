/**
 * Guard: processing UI must not spam /books or /ingest/{id} (KV-backed reads).
 */
import { test, expect } from "@playwright/test";
import { bootPlayer, PROCESSING_BOOK } from "./fixtures.js";

const JOB_ID = "e2e-job-1";

const PROC_DETAIL = {
  ...PROCESSING_BOOK,
  status: "processing",
  stage: "imaging",
  progress: 0.5,
  job_id: JOB_ID,
  active_job_id: JOB_ID,
};

const PROC_CATALOG = [{
  book_id: PROC_DETAIL.book_id,
  title: PROC_DETAIL.title,
  author: "",
  status: "processing",
  stage: "imaging",
  progress: 0.5,
  cover: null,
  scenes: 2,
  lines: 9,
  job_id: JOB_ID,
  active_job_id: JOB_ID,
}];

test.describe("KV-friendly client (no job status polling)", () => {
  test("one SSE stream per job, no repeated GET /ingest/{id}", async ({ page }) => {
    const ingestGets = [];
    const booksGets = [];
    let sseOpens = 0;

    await page.route(`**/ingest/${JOB_ID}/events`, async (route) => {
      sseOpens += 1;
      const stream = [
        'data: {"type":"progress","status":"processing","stage":"imaging","progress":0.55,"detail":"Generating art"}\n\n',
      ].join("");
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: stream,
      });
    });

    await page.route(`**/ingest/${JOB_ID}`, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      ingestGets.push(Date.now());
      await route.fulfill({
        json: {
          job_id: JOB_ID,
          status: "processing",
          stage: "imaging",
          progress: 0.55,
          detail: "Generating art",
        },
      });
    });

    await bootPlayer(page, {
      backend: {
        catalog: () => {
          booksGets.push(Date.now());
          return PROC_CATALOG;
        },
        detail: PROC_DETAIL,
      },
    });

    await expect(page.getByTestId("processing-bar")).toBeVisible();
    await page.waitForTimeout(4000);

    expect(ingestGets.length, "client must not poll GET /ingest/{id}").toBe(0);
    expect(sseOpens, "at most one SSE open per job in stable UI").toBeGreaterThanOrEqual(1);
    // 3, not 2: bootPlayer renders the Library view first (its own jobWatchKey
    // effect opens one SSE stream for the still-processing catalog entry) before
    // auto-clicking into the Player, whose useJobEvents hook opens a second one
    // — doubled to 2 by React StrictMode's intentional dev-mode double-effect-invoke.
    expect(sseOpens, "at most one SSE open per job in stable UI (+1 for StrictMode double-invoke, +1 for Library's own transient subscription before navigating to Player)").toBeLessThanOrEqual(3);
    expect(booksGets.length, "no /books polling loop while SSE drives progress").toBeLessThanOrEqual(2);
  });
});
