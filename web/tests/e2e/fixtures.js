// Shared test harness: deterministic Audio stub, route mocks, expected data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildTestPackZip, minimalBook, TIER_VISUAL, TIER_AUDIOBOOK } from "../../src/offline/testPackFixtures.js";
import { KEYS } from "../../src/audio/voicePrefs.js";

/** Map high-level pref overrides (e.g. { autoAdvance: false }) to raw localStorage entries. */
function prefsToLocalStorageEntries(prefs) {
  if (!prefs) return [];
  return Object.entries(prefs)
    .filter(([k]) => KEYS[k])
    .map(([k, v]) => [KEYS[k], String(v)]);
}

export { buildTestPackZip, minimalBook, TIER_VISUAL, TIER_AUDIOBOOK };

const BOOK_PATH = fileURLToPath(
  new URL("../../../data/books/the-silver-gate.json", import.meta.url));
export const SAMPLE_BOOK = JSON.parse(readFileSync(BOOK_PATH, "utf8"));

const LINES = SAMPLE_BOOK.scenes.reduce((n, s) => n + s.lines.length, 0);

export const CATALOG = [{
  book_id: SAMPLE_BOOK.book_id, title: SAMPLE_BOOK.title, author: SAMPLE_BOOK.author,
  status: "ready", stage: "done", progress: 1, cover: null,
  scenes: SAMPLE_BOOK.scenes.length, lines: LINES, server_available: true,
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

export async function installAudioStub(page, { clipMs = 40, durationSec = 0.4, prefs = null } = {}) {
  const prefsEntries = prefsToLocalStorageEntries(prefs);
  await page.addInitScript(async ({ clipMs, durationSec, prefsEntries }) => {
    try {
      window.localStorage.setItem("vae-e2e", "1");
      for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
        const k = window.localStorage.key(i);
        if (k?.startsWith("vae-dl-skip-")) window.localStorage.removeItem(k);
      }
      for (const [k, v] of prefsEntries) window.localStorage.setItem(k, v);
    } catch {}
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase("vae-offline");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
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
  }, { clipMs, durationSec, prefsEntries });
}

/**
 * Mock the backend.
 *   booksStatus: 'ok' | 'empty' | 'fail'
 *   catalog: override the catalog array (or a function() returning one — called each request)
 *   detail:  override the book-detail payload (or a function(callCount) => payload)
 *   ttsStatus: 200 | 204 | 4xx/5xx (or a function(body, callCount) => status)
 * Returns { ttsCalls, detailCalls } live counters.
 */
export async function installBackendMocks(page, opts = {}) {
  const {
    booksStatus = "ok",
    catalog = null,
    detail = null,
    ttsStatus = 200,
    packZip = null,
    packBook = null,
    packTier = TIER_VISUAL,
    packStatus = 200,
  } = opts;
  const ttsCalls = [];
  const detailCalls = { n: 0 };

  await page.route("**/tts", async (route) => {
    let body = {};
    try { body = route.request().postDataJSON(); } catch { /* ignore */ }
    ttsCalls.push(body);
    const status = typeof ttsStatus === "function" ? ttsStatus(body, ttsCalls.length) : ttsStatus;
    if (status === 204) return route.fulfill({ status: 204, body: "" });
    if (status >= 400) return route.fulfill({ status, body: "err" });
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

  await page.route("**/books/*/audio/**", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill({ json: { book_id: "pack-e2e", available: false, line_count: 0 } });
    }
    return route.fallback();
  });

  await page.route("**/books/*/pack**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const bookIdMatch = url.match(/\/books\/([^/]+)\/pack/);
    const bookId = bookIdMatch?.[1] || "pack-e2e";

    if (url.includes("/pack/build")) {
      if (method === "POST" && url.includes("/cancel")) {
        return route.fulfill({ json: { job_id: "e2e-pack-job", status: "cancelled" } });
      }
      if (method === "POST") {
        if (packStatus >= 400) {
          return route.fulfill({ status: packStatus, json: { error: "pack build failed" } });
        }
        return route.fulfill({
          json: { job_id: "e2e-pack-job", status: "building", progress: 0, book_id: bookId },
        });
      }
      if (url.includes("/pack/build/e2e-pack-job/file")) {
        const payload = packZip ?? buildTestPackZip({
          book: typeof packBook === "function" ? packBook() : (packBook || minimalBook({ book_id: bookId })),
          tier: packTier || TIER_VISUAL,
          withAudio: packTier === TIER_AUDIOBOOK,
        });
        return route.fulfill({
          status: 200,
          contentType: "application/zip",
          body: Buffer.from(payload),
        });
      }
      if (url.includes("/pack/build/e2e-pack-job")) {
        if (packStatus >= 400) {
          return route.fulfill({ status: packStatus, json: { job_id: "e2e-pack-job", status: "error", error: "pack failed" } });
        }
        return route.fulfill({
          json: { job_id: "e2e-pack-job", status: "done", progress: 1, ready: true },
        });
      }
      return route.fallback();
    }

    if (method !== "GET" || !url.match(/\/pack(\?|$)/)) return route.fallback();
    if (packStatus >= 400) {
      return route.fulfill({ status: packStatus, body: "pack error" });
    }
    const payload = packZip ?? buildTestPackZip({
      book: typeof packBook === "function" ? packBook() : (packBook || minimalBook()),
      tier: packTier || TIER_VISUAL,
      withAudio: packTier === TIER_AUDIOBOOK,
    });
    return route.fulfill({
      status: 200,
      contentType: "application/zip",
      body: Buffer.from(payload),
    });
  });

  await page.route("**/books/*", async (route) => {
    const url = route.request().url();
    if (url.includes("/pack")) return route.fallback();
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

/** Clear vae-offline IndexedDB before navigation (fresh pack install tests). */
export async function clearOfflinePacks(page) {
  await page.addInitScript(async () => {
    try { window.localStorage.setItem("vae-e2e-cache", "1"); } catch {}
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase("vae-offline");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });
}

/** Boot at the library, optionally open the first/chosen book into the player. */
export async function bootPlayer(page, opts = {}) {
  await installAudioStub(page, { ...opts.audio, prefs: opts.prefs });
  const mocks = await installBackendMocks(page, opts.backend);
  await page.goto("/");
  if (opts.openBook !== false) {
    const card = opts.bookId
      ? page.locator(`[data-testid="book-card"][data-book="${opts.bookId}"]`)
      : page.getByTestId("book-card").first();
    await card.click();
    const skip = page.getByTestId("download-recommend-skip");
    if (await skip.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await skip.click();
    }
    if (opts.expectPlayer !== false) {
      await page.getByTestId("progress").waitFor({ timeout: 20_000 });
    }
  }
  return mocks;
}

/** Boot and stay on the library view. */
export async function bootLibrary(page, opts = {}) {
  return bootPlayer(page, { ...opts, openBook: false });
}
