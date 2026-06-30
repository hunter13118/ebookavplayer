// ALGORITHM 4 — Local Phonetic Forced-Aligner ("Smart Offline"), client side.
//
// The heavy acoustic work runs on the user's OWN machine (the FastAPI server tier,
// see server/align/). This module is the thin browser client: it POSTs the book id
// (and optionally an m4b path the local server can read) to the local aligner
// endpoint, then normalizes the returned ExternalAudioPack-shaped manifest
// ({ lines: [{ line_idx, start_ms, end_ms }] }) into our unified TimingResult.
//
// Because the manifest the aligner writes is the SAME shape the player already
// consumes (server/pack/external_audio.py + GET /books/{id}/audio/manifest), the
// timeline drops straight into the existing offline-audio path.

import { buildResult } from "./slides.js";

export const ALIGNER_MARKER = "phonetic-forced-align";

/**
 * Normalize a manifest ({ lines:[{line_idx,start_ms,end_ms}] }) + the script's
 * chapter grouping into a unified TimingResult.
 *
 * @param {{lines: Array<{line_idx:number,start_ms:number,end_ms:number}>}} manifest
 * @param {import('./types.js').ChapterSlides[]} slidesByChapter
 * @param {Object} [meta]
 * @returns {import('./types.js').TimingResult}
 */
export function manifestToTimingResult(manifest, slidesByChapter, meta = {}) {
  const byLine = new Map();
  for (const entry of manifest?.lines || []) {
    if (entry == null || entry.line_idx == null) continue;
    const startMs = Math.round(entry.start_ms ?? 0);
    const endMs = Math.round(entry.end_ms ?? startMs);
    byLine.set(Number(entry.line_idx), { startMs, endMs });
  }

  /** @type {import('./types.js').ChapterTiming[]} */
  const chapters = slidesByChapter.map((ch) => {
    const slides = ch.slides.map((s) => {
      const t = byLine.get(s.lineIndex) || { startMs: 0, endMs: 0 };
      const startMs = t.startMs;
      const endMs = Math.max(startMs, t.endMs);
      return { lineIndex: s.lineIndex, startMs, endMs, durationMs: endMs - startMs, charCount: s.charCount };
    });
    const startMs = slides.length ? slides[0].startMs : 0;
    const endMs = slides.length ? slides[slides.length - 1].endMs : startMs;
    return { chapter: ch.chapter, startMs, endMs, durationMs: endMs - startMs, slides };
  });

  return buildResult("forced-aligner", ALIGNER_MARKER, chapters, { strategy: "phonetic", ...meta });
}

/**
 * Request a forced alignment from the local server and return a TimingResult.
 *
 * @param {Object} input
 * @param {string} input.bookId
 * @param {import('./types.js').ChapterSlides[]} input.slidesByChapter
 * @param {string} [input.m4bPath]   Server-readable path to the .m4b (local host).
 * @param {string} [input.apiBase]   Defaults to '' (same-origin / dev proxy).
 * @param {typeof fetch} [input.fetchImpl]  Injectable for tests.
 * @returns {Promise<import('./types.js').TimingResult>}
 */
export async function forcedAlignerClient({ bookId, slidesByChapter, m4bPath, apiBase = "", fetchImpl }) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) throw new Error("forcedAlignerClient: no fetch implementation available");
  const base = String(apiBase || "").replace(/\/$/, "");
  const url = `${base}/books/${encodeURIComponent(bookId)}/audio/align`;
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ book_id: bookId, m4b_path: m4bPath }),
  });
  if (!res.ok) {
    throw new Error(`forced aligner: HTTP ${res.status}`);
  }
  const manifest = await res.json();
  return manifestToTimingResult(manifest, slidesByChapter, {
    source: "local-server",
    engine: manifest?.audio_engine || "forced-aligner",
  });
}
