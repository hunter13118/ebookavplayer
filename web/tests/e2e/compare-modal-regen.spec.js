/**
 * Regen → compare modal must stay open until user picks Keep new / Keep previous.
 * Catches flicker bug where modal briefly appears then auto-dismisses.
 */
import { test, expect } from "@playwright/test";
import { bootPlayer, SAMPLE_BOOK } from "./fixtures.js";

const JOB_ID = "test-regen-job";
const BOOK_ID = SAMPLE_BOOK.book_id;

const ELARA_COMPARE = {
  kind: "characters",
  key: "elara",
  before_url: "/media/the-silver-gate/semi-real/char_elara.png?v=1",
  after_url: "/media/the-silver-gate/semi-real/char_elara.next.png?v=2",
};

function sseLine(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function regenSseBody({ comparisons = [ELARA_COMPARE], delayDoneMs = 200 } = {}) {
  const lines = [
    sseLine({
      type: "progress",
      status: "processing",
      stage: "imaging",
      progress: 0.35,
      detail: "Generating Elara",
    }),
    sseLine({
      type: "comparison",
      status: "processing",
      stage: "imaging",
      progress: 0.85,
      comparisons,
    }),
  ];
  if (delayDoneMs > 0) {
    lines.push(`: delay ${delayDoneMs}\n\n`);
  }
  lines.push(
    sseLine({
      type: "done",
      status: "done",
      stage: "done",
      progress: 1,
      detail: `Art regen complete · review ${comparisons.length} image(s)`,
      comparisons,
    }),
  );
  return lines.join("");
}

async function installRegenRoutes(page, { sseBody = regenSseBody() } = {}) {
  await page.route("**/books/*/imaging/unlock**", async (route) =>
    route.fulfill({ json: { ok: true } }));

  await page.route("**/books/*/generate-media", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      json: { job_id: JOB_ID, book_id: BOOK_ID, status: "queued" },
    });
  });

  await page.route(`**/ingest/${JOB_ID}/events`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
      body: sseBody,
    });
  });

  await page.route("**/books/*/media/commit", async (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, kind: body?.kind, key: body?.key } });
  });

  await page.route("**/books/*/media/revert", async (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, kind: body?.kind, key: body?.key } });
  });
}

async function startElaraRegen(page) {
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("reader-menu")).toBeVisible();
  await page.getByTestId("open-replace").click();
  await expect(page.getByTestId("replace-sheet")).toBeVisible();
  await page.getByTestId("replace-select-none").click();
  await page.locator('[data-art-key="char:elara"]').click();
  await page.getByTestId("replace-submit").click();
  await expect(page.getByTestId("replace-sheet")).not.toBeVisible();
}

/** Poll visibility — modal must stay open for holdMs without user interaction. */
async function assertModalStaysOpen(page, holdMs = 2500) {
  const sheet = page.getByTestId("compare-sheet");
  await expect(sheet).toBeVisible({ timeout: 10_000 });

  const start = Date.now();
  while (Date.now() - start < holdMs) {
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(200);
  }
}

test.describe("Compare modal after regen", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await installRegenRoutes(page);
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
  });

  test("compare sheet stays open until user picks Keep new", async ({ page }) => {
    await startElaraRegen(page);
    await assertModalStaysOpen(page, 2500);

    await expect(page.getByTestId("compare-sheet").getByRole("heading", { name: "Compare new art" })).toBeVisible();
    await expect(page.getByTestId("compare-sheet").getByText(/Elara — pick which version/)).toBeVisible();

    await page.getByRole("button", { name: "Keep new" }).click();
    await expect(page.getByTestId("compare-sheet")).not.toBeVisible({ timeout: 5_000 });
  });

  test("compare sheet stays open until user picks Keep previous", async ({ page }) => {
    await startElaraRegen(page);
    await assertModalStaysOpen(page, 2500);

    await page.getByRole("button", { name: "Keep previous" }).click();
    await expect(page.getByTestId("compare-sheet")).not.toBeVisible({ timeout: 5_000 });
  });

  test("second queued compare shows after first choice", async ({ page }) => {
    const garrickCompare = {
      kind: "characters",
      key: "garrick",
      before_url: "/media/the-silver-gate/semi-real/char_garrick.png?v=1",
      after_url: "/media/the-silver-gate/semi-real/char_garrick.next.png?v=2",
    };

    await installRegenRoutes(page, {
      sseBody: regenSseBody({ comparisons: [ELARA_COMPARE, garrickCompare] }),
    });

    await startElaraRegen(page);
    await assertModalStaysOpen(page, 1500);
    await expect(page.getByTestId("compare-sheet").getByText(/Elara — pick which version/)).toBeVisible();

    await page.getByRole("button", { name: "Keep new" }).click();
    await expect(page.getByTestId("compare-sheet")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("compare-sheet").getByText(/Garrick — pick which version/)).toBeVisible();
    await assertModalStaysOpen(page, 1500);
  });
});
