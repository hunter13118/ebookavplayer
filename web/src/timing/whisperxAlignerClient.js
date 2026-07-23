// WhisperX forced-align (local server), client side.
//
// Unlike the client-side estimation algorithms (linear, punctuation-aware,
// moov-atom), this one does REAL acoustic work: the local align server
// (scripts/local-align-server/) transcribes what the audiobook
// ACTUALLY says (WhisperX ASR) and fuzzy-matches that against our known
// line texts, so it's robust to audio/text differences (ad-libbed intros,
// minor abridgment) rather than assuming word-for-word agreement.
//
// Every known line, across every chapter, is sent flattened and in book
// order — there's no per-chapter start/end guess anymore. Sending a guess
// was the actual bug this replaced: commercial audiobooks routinely open
// with narration that isn't in the EPUB at all ("Seven Seas Sirens
// presents...", "This is Audible"), and any guessed boundary that ate into
// chapter 1's span threw off every later chapter's guess too. The server
// now transcribes the WHOLE file once (chunked only for progress/memory,
// not content) and fuzzy-matches the whole book against that one continuous
// transcript, so front/back matter simply fails to match anything instead
// of being mistaken for book content. See server.py's module docstring.
//
// The server streams "chunk" rows as each transcription window completes —
// each carrying only the lines newly resolved since the last row, often
// available within seconds of a fresh attach (the first chunk is small on
// purpose). onLinesReady fires per row so a caller can merge real timings
// into an already-playing estimate live, instead of blocking on the whole
// book before anything plays. The returned Promise still only resolves once
// the server's "done" row arrives, for callers that want the complete,
// final TimingResult (e.g. to cache).

import { buildResult } from "./slides.js";

export const WHISPERX_MARKER = "whisperx-forced-align";

/**
 * Read a fetch Response body as NDJSON, calling onLine for each parsed object
 * as soon as its line completes (not waiting for the whole stream).
 *
 * `onLine` is awaited before the next line is processed. Callers persist a
 * checkpoint per row (Player.jsx's persistProgress) into the SAME local
 * alignCache record on every chunk — letting two rows' writes race was a
 * real bug (last-write-wins could silently revert an already-saved line or
 * drop the resume checkpoint, both indistinguishable from "resume didn't
 * work" — see transcribeClient.js's identical fix for the M4B-first flow).
 */
async function readNdjson(res, onLine) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    // Environments without a streaming body (some test fetches) — fall back
    // to reading the whole text at once and splitting it.
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (line.trim()) await onLine(JSON.parse(line));
    }
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    // eslint-disable-next-line no-cond-assign
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) await onLine(JSON.parse(line));
    }
  }
  if (buffer.trim()) await onLine(JSON.parse(buffer));
}

/**
 * Request a WhisperX forced alignment from the local align server and
 * return a TimingResult.
 *
 * @param {Object} input
 * @param {Blob} input.blob                         The attached .m4b file.
 * @param {import('./types.js').ChapterSlides[]} input.slidesByChapter
 * @param {{baseUrl:string}} input.connection        Which local server to hit (from backends/connections.js).
 * @param {(processedMs:number, totalMs:number) => void} [input.onChapterProgress]
 *        Named onChapterProgress for signature compatibility with the other
 *        algorithms' progress callback, but now reports audio ms transcribed
 *        so far — there's no per-chapter granularity to report anymore.
 * @param {(partialLineTimingsByIdx: Record<number,{startMs:number,endMs:number,durationMs:number,words?:Array}>) => void} [input.onLinesReady]
 *        Fired once per "chunk" row that resolved at least one new line —
 *        lets a caller apply real timings to a live playback timeline
 *        (e.g. orchestrator.extendTimeline) as they arrive, well before the
 *        whole book finishes aligning.
 * @param {(newGaps: Array<{id:string,startMs:number,endMs:number,text:string}>) => void} [input.onGapsReady]
 *        Fired once per chunk row that resolved at least one new gap —
 *        audio-only content with no book-line counterpart (an ad-libbed
 *        intro, a spoken chapter title, a publisher bumper). Separate from
 *        onLinesReady since gaps aren't keyed by lineIndex.
 * @param {number} [input.resumeMs]  Skip straight to this audio offset — a
 *        prior run already covered everything before it. `slidesByChapter`
 *        must ALREADY be trimmed to just the not-yet-resolved lines by the
 *        caller (Player.jsx) — the aligner matches audio against `lines` in
 *        order from its own index 0, so sending the full book here while
 *        skipping audio would match mid-book audio against the BEGINNING of
 *        the book text.
 * @param {typeof fetch} [input.fetchImpl]           Injectable for tests.
 * @returns {Promise<import('./types.js').TimingResult>}
 */
export async function whisperxAlignerClient({
  blob, slidesByChapter, connection, onChapterProgress, onLinesReady, onGapsReady, resumeMs = 0, fetchImpl,
}) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) throw new Error("whisperxAlignerClient: no fetch implementation available");
  if (!connection?.baseUrl) throw new Error("whisperxAlignerClient: no align server connection selected");

  // Every line in the whole book, flattened in book order — the server
  // matches this against one continuous transcript of the whole file, so
  // chapter boundaries fall out of the match rather than being guessed
  // beforehand (see server.py's module docstring for why that mattered).
  const linesPayload = slidesByChapter.flatMap((ch) => ch.slides.map((s) => ({ idx: s.lineIndex, text: s.text })));

  const form = new FormData();
  form.append("m4b", blob, "audiobook");
  form.append("lines", JSON.stringify(linesPayload));
  if (resumeMs > 0) form.append("resume_ms", String(Math.round(resumeMs)));

  const base = String(connection.baseUrl).replace(/\/$/, "");
  const res = await doFetch(`${base}/align`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`whisperx align server: HTTP ${res.status}`);

  const lineTimingsByIdx = new Map();
  const gaps = [];
  let alignMeta = {};
  let sawDone = false;
  let streamErr = null;
  await readNdjson(res, async (row) => {
    if (row.status === "error") {
      streamErr = row.error || "alignment failed";
      return;
    }
    if (row.status === "chunk") {
      if (row.meta) alignMeta = row.meta;
      const partial = {};
      for (const line of row.lines || []) {
        const timing = { startMs: line.start_ms, endMs: Math.max(line.start_ms, line.end_ms), words: line.words };
        lineTimingsByIdx.set(line.idx, timing);
        partial[line.idx] = { ...timing, durationMs: timing.endMs - timing.startMs };
      }
      // Awaited in order — onLinesReady/onGapsReady/onChapterProgress all
      // write the SAME local pack record (persistProgress in Player.jsx);
      // running them concurrently, or racing across rows, risks a stale
      // read-modify-write clobbering another's write (see readNdjson's doc
      // comment above).
      if (Object.keys(partial).length) await onLinesReady?.(partial);

      const newGaps = [];
      for (const g of row.gaps || []) {
        const entry = { id: `gap-${gaps.length}`, startMs: g.start_ms, endMs: Math.max(g.start_ms, g.end_ms), text: g.text };
        gaps.push(entry);
        newGaps.push(entry);
      }
      if (newGaps.length) await onGapsReady?.(newGaps);

      await onChapterProgress?.(row.processed_ms, row.total_ms);
      return;
    }
    if (row.status === "done") {
      if (row.meta) alignMeta = row.meta;
      sawDone = true;
    }
  });
  if (!sawDone) throw new Error(streamErr || "whisperx align server: stream ended without a result");

  /** @type {import('./types.js').ChapterTiming[]} */
  const chapters = slidesByChapter.map((ch) => {
    const slides = ch.slides.map((s) => {
      const t = lineTimingsByIdx.get(s.lineIndex);
      const startMs = t ? Math.round(t.startMs) : 0;
      const endMs = t ? Math.max(startMs, Math.round(t.endMs)) : startMs;
      return {
        lineIndex: s.lineIndex, startMs, endMs, durationMs: endMs - startMs,
        charCount: s.charCount, words: t?.words,
      };
    });
    const startMs = slides.length ? slides[0].startMs : 0;
    const endMs = slides.length ? slides[slides.length - 1].endMs : startMs;
    return { chapter: ch.chapter, startMs, endMs, durationMs: endMs - startMs, slides };
  });

  return buildResult("whisperx", WHISPERX_MARKER, chapters, {
    strategy: "acoustic",
    chapterBoundarySource: "acoustic-match",
    ...alignMeta,
  }, gaps);
}
