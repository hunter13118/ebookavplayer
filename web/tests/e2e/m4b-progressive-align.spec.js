import { test, expect } from "@playwright/test";
import { bootPlayer, SAMPLE_BOOK } from "./fixtures.js";

// The whole point of the progressive WhisperX design (see
// web/src/timing/whisperxAlignerClient.js, scripts/local-align-server/server.py):
// a freshly-attached .m4b is playable IMMEDIATELY on an instant client-side
// estimate, while real per-line timings stream in from the local align
// server a chunk at a time and get merged into the live timeline in the
// background — never blocking playback on the whole book finishing.
//
// Playwright's page.route() delivers a mocked response body atomically (no
// real inter-chunk network delay), so genuine incremental-arrival timing is
// scripted here via a page-level `window.fetch` override instead (a real
// ReadableStream with setTimeout-spaced enqueues) — this is the only way to
// prove "attach resolves before the align stream finishes" rather than
// asserting on a response that was already fully buffered by the mock layer.

const ALIGN_BASE = "http://127.0.0.1:19999";
const CONNECTION_ID = "e2e-whisperx";

function bookLines() {
  const lines = [];
  for (const scene of SAMPLE_BOOK.scenes) {
    for (const line of scene.lines) lines.push(line);
  }
  return lines;
}

/** Seed a fixed-id backend connection + WhisperX prefs directly via localStorage,
 * bypassing the Settings > Backends UI entirely (same pattern bootPlayer already
 * uses for other prefs). */
async function seedWhisperxConnection(page) {
  await page.addInitScript(({ id, baseUrl }) => {
    window.localStorage.setItem("vae-backend-connections", JSON.stringify([
      { id, label: "Local WhisperX (e2e)", kind: "remote", baseUrl, createdAt: 0 },
    ]));
  }, { id: CONNECTION_ID, baseUrl: ALIGN_BASE });
}

/** Script window.fetch to answer the align server's /health and /align contract
 * with a REAL incrementally-delayed NDJSON stream — everything else falls
 * through to the real fetch (so Playwright's page.route mocks still apply). */
async function mockAlignServer(page, { rows, delayMs = 60 }) {
  await page.addInitScript(({ baseUrl, rows: scriptedRows, delayMs: delay }) => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(baseUrl)) {
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ ok: true, status: "ok", ready: true, model: "small" }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/align")) {
          const stream = new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              for (const row of scriptedRows) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise((r) => { setTimeout(r, delay); });
                controller.enqueue(encoder.encode(`${JSON.stringify(row)}\n`));
              }
              controller.close();
            },
          });
          return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
        }
      }
      return realFetch(input, init);
    };
  }, { baseUrl: ALIGN_BASE, rows, delayMs });
}

test.describe("Progressive WhisperX m4b alignment", () => {
  test("attach resolves and playback is available BEFORE the background alignment stream finishes", async ({ page }) => {
    const lines = bookLines();
    const totalMs = 600_000;
    const rows = [
      {
        status: "chunk",
        lines: [{ idx: 0, start_ms: 500, end_ms: 1500, words: [] }],
        processed_ms: 240_000, total_ms: totalMs,
        meta: { asr_device: "cpu", align_device: "mps", lead_in_ms: 500, unmatched_line_count: 0 },
      },
      {
        status: "chunk",
        lines: lines.slice(1).map((l, i) => ({ idx: i + 1, start_ms: 1500 + i * 1000, end_ms: 2500 + i * 1000, words: [] })),
        processed_ms: totalMs, total_ms: totalMs,
        meta: { asr_device: "cpu", align_device: "mps", lead_in_ms: 500, unmatched_line_count: 0 },
      },
      { status: "done", meta: { asr_device: "cpu", align_device: "mps", lead_in_ms: 500, unmatched_line_count: 0 } },
    ];

    await seedWhisperxConnection(page);
    await mockAlignServer(page, { rows, delayMs: 150 });

    await bootPlayer(page, {
      prefs: { timingAlgorithm: "whisperx", alignConnectionId: CONNECTION_ID },
    });

    await page.getByTestId("open-settings").click();
    const fileInput = page.getByTestId("m4b-attach");
    await fileInput.setInputFiles({
      name: "audiobook.m4b", mimeType: "audio/mp4", buffer: Buffer.from("fake m4b bytes for e2e"),
    });

    // Attach resolves (estimate applied) well before all 3 mocked NDJSON
    // rows have arrived (3 rows * 150ms = 450ms minimum for the full stream).
    await expect(page.getByTestId("m4b-attached-label")).toBeVisible({ timeout: 2000 });
    await expect(page.getByTestId("m4b-aligning-progress")).toBeVisible();

    // Playback works immediately, on the estimate — proves attach isn't
    // gated on the whole book finishing alignment.
    await page.locator(".vae-sheet-close").click(); // close the sheet, matching real usage
    await page.getByTestId("play").click();
    await expect(page.getByTestId("progress")).toBeVisible();

    // Once every mocked chunk (plus "done") has streamed in, the background
    // indicator clears — proving the whole pipeline completed and merged.
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("m4b-aligning-progress")).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId("m4b-attached-label")).toBeVisible();
  });

  test("a hard failure from the align stream surfaces as an error without breaking already-working playback", async ({ page }) => {
    const rows = [{ status: "error", error: "ffprobe failed to read duration" }];

    await seedWhisperxConnection(page);
    await mockAlignServer(page, { rows, delayMs: 50 });

    await bootPlayer(page, {
      prefs: { timingAlgorithm: "whisperx", alignConnectionId: CONNECTION_ID },
    });

    await page.getByTestId("open-settings").click();
    await page.getByTestId("m4b-attach").setInputFiles({
      name: "audiobook.m4b", mimeType: "audio/mp4", buffer: Buffer.from("fake m4b bytes"),
    });

    // The estimate still attaches immediately...
    await expect(page.getByTestId("m4b-attached-label")).toBeVisible({ timeout: 2000 });
    // ...and the background failure surfaces as an error once the stream ends.
    await expect(page.getByTestId("m4b-error")).toBeVisible({ timeout: 3000 });
    await expect(page.getByTestId("m4b-error")).toContainText("ffprobe failed to read duration");

    // Playback still works on the (unrefined, estimate-only) timeline —
    // one bad background alignment run must not break the player.
    await page.locator(".vae-sheet-close").click();
    await page.getByTestId("play").click();
    await expect(page.getByTestId("progress")).toBeVisible();
  });

  test("a gap (audio-only content with no book-line match) streams through to the processing log instead of being silently dropped", async ({ page }) => {
    const lines = bookLines();
    const totalMs = 600_000;
    const rows = [
      {
        status: "chunk",
        lines: [{ idx: 0, start_ms: 500, end_ms: 1500, words: [] }],
        gaps: [{ start_ms: 1500, end_ms: 3000, text: "hey listener, thanks for tuning in to this bonus scene", word_count: 10 }],
        processed_ms: 240_000, total_ms: totalMs,
        meta: { asr_device: "cpu", align_device: "mps", lead_in_ms: 500, unmatched_line_count: 0 },
      },
      {
        status: "chunk",
        lines: lines.slice(1).map((l, i) => ({ idx: i + 1, start_ms: 3000 + i * 1000, end_ms: 4000 + i * 1000, words: [] })),
        processed_ms: totalMs, total_ms: totalMs,
        meta: { asr_device: "cpu", align_device: "mps", lead_in_ms: 500, unmatched_line_count: 0 },
      },
      { status: "done", meta: { asr_device: "cpu", align_device: "mps", lead_in_ms: 500, unmatched_line_count: 0 } },
    ];

    await seedWhisperxConnection(page);
    await mockAlignServer(page, { rows, delayMs: 100 });

    await bootPlayer(page, {
      prefs: { timingAlgorithm: "whisperx", alignConnectionId: CONNECTION_ID },
    });

    await page.getByTestId("open-settings").click();
    await page.getByTestId("m4b-attach").setInputFiles({
      name: "audiobook.m4b", mimeType: "audio/mp4", buffer: Buffer.from("fake m4b bytes for e2e"),
    });

    await expect(page.getByTestId("m4b-attached-label")).toBeVisible({ timeout: 2000 });

    // The gap is surfaced through the same top-of-player processing log used
    // for extraction/imaging — not silently discarded the way it was before
    // gap detection existed.
    await expect(page.getByTestId("processing-log")).toContainText("Found 1 narrator aside", { timeout: 3000 });

    // The rest of the pipeline still completes normally once the stream ends.
    await expect(page.getByTestId("m4b-aligning-progress")).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId("m4b-error")).toHaveCount(0);
  });
});
