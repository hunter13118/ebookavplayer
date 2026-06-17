// Shared test harness: deterministic Audio stub, route mocks, expected data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BOOK_PATH = fileURLToPath(
  new URL("../../../data/books/the-silver-gate.json", import.meta.url));
export const SAMPLE_BOOK = JSON.parse(readFileSync(BOOK_PATH, "utf8"));

const LINES = SAMPLE_BOOK.scenes.reduce((n, s) => n + s.lines.length, 0);

export const CATALOG = [{
  book_id: SAMPLE_BOOK.book_id, title: SAMPLE_BOOK.title, author: SAMPLE_BOOK.author,
  status: "ready", stage: "done", progress: 1, cover: null,
  scenes: SAMPLE_BOOK.scenes.length, lines: LINES,
}];

export const EXPECTED_LINES = SAMPLE_BOOK.scenes.flatMap((s) =>
  s.lines.map((l) => ({
    sceneId: s.id, sceneTitle: s.title, characterId: l.character_id,
    voice: l.voice, pitch: l.pitch, text: l.text,
  })));

export const TOTAL_LINES = EXPECTED_LINES.length;

// A book mid-processing: playable lines + placeholder media + progress < 1.
export const PROCESSING_BOOK = {
  ...SAMPLE_BOOK, status: "ready", stage: "imaging", progress: 0.55, resume: null,
};

export async function installAudioStub(page, { clipMs = 40, durationSec = 0.4 } = {}) {
  await page.addInitScript(({ clipMs, durationSec }) => {
    try { window.localStorage.setItem("vae-e2e", "1"); } catch {}  // bypass AuthGate
    class FakeAudio {
      constructor(src) {
        this.src = src; this.playbackRate = 1; this.paused = true;
        this.onended = null; this.onerror = null; this.onloadedmetadata = null;
        this._timer = null;
        window.__audioCreated = (window.__audioCreated || 0) + 1;
      }
      get duration() { return durationSec; }
      play() {
        this.paused = false;
        window.__lastRate = this.playbackRate;   // for speed assertions
        if (this.onloadedmetadata) this.onloadedmetadata();
        this._timer = setTimeout(() => { if (!this.paused && this.onended) this.onended(); }, clipMs);
        return Promise.resolve();
      }
      pause() { this.paused = true; if (this._timer) { clearTimeout(this._timer); this._timer = null; } }
    }
    window.Audio = FakeAudio;
    if (!window.URL.createObjectURL) window.URL.createObjectURL = () => "blob:fake";
    if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};
  }, { clipMs, durationSec });
}

/**
 * Mock the backend.
 *   booksStatus: 'ok' | 'empty' | 'fail'
 *   catalog: override the catalog array (or a function() returning one — called each request)
 *   detail:  override the book-detail payload (or a function(callCount) => payload)
 *   ttsStatus: 200 | 204 | 4xx/5xx
 * Returns { ttsCalls, detailCalls } live counters.
 */
export async function installBackendMocks(page, {
  booksStatus = "ok", catalog = null, detail = null, ttsStatus = 200,
} = {}) {
  const ttsCalls = [];
  const detailCalls = { n: 0 };

  await page.route("**/tts", async (route) => {
    let body = {};
    try { body = route.request().postDataJSON(); } catch { /* ignore */ }
    ttsCalls.push(body);
    if (ttsStatus === 204) return route.fulfill({ status: 204, body: "" });
    if (ttsStatus >= 400) return route.fulfill({ status: ttsStatus, body: "err" });
    return route.fulfill({ status: 200, contentType: "audio/mpeg",
      body: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00]) });
  });

  await page.route("**/books", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (booksStatus === "fail") return route.abort();
    if (booksStatus === "empty") return route.fulfill({ json: [] });
    const list = typeof catalog === "function" ? catalog() : (catalog || CATALOG);
    return route.fulfill({ json: list });
  });

  await page.route("**/books/*", async (route) => {
    detailCalls.n += 1;
    const payload = typeof detail === "function"
      ? detail(detailCalls.n)
      : (detail || SAMPLE_BOOK);
    return route.fulfill({ json: payload });
  });

  // resume sync (POST/GET) — registered last so it wins over **/books/*
  await page.route("**/books/*/progress", async (route) =>
    route.fulfill({ json: { ok: true, line: 0 } }));

  return { ttsCalls, detailCalls };
}

/** Boot at the library, optionally open the first/chosen book into the player. */
export async function bootPlayer(page, opts = {}) {
  await installAudioStub(page, opts.audio);
  const mocks = await installBackendMocks(page, opts.backend);
  await page.goto("/");
  if (opts.openBook !== false) {
    const card = opts.bookId
      ? page.locator(`[data-testid="book-card"][data-book="${opts.bookId}"]`)
      : page.getByTestId("book-card").first();
    await card.click();
    if (opts.expectPlayer !== false) await page.getByTestId("progress").waitFor();
  }
  return mocks;
}

/** Boot and stay on the library view. */
export async function bootLibrary(page, opts = {}) {
  return bootPlayer(page, { ...opts, openBook: false });
}
