// M4B-first transcription (local align server), client side.
//
// The counterpart to whisperxAlignerClient.js, for the OTHER direction: there
// the book text is known (from an EPUB) and the server fuzzy-matches it against
// what the audiobook says. Here the audiobook is the ONLY input — the server
// transcribes the whole file and the transcript IS the book text. No known
// lines to send, no matching; just stream the raw sentence-lines (each with
// per-word ms timings) back as each time-window resolves.
//
// The returned "transcript book" is the minimal book model the M4B-first flow
// runs on (see docs/M4B_FIRST_FLOW.md):
//   { bookId, title, durationMs, lines:[{ idx, text, startMs, endMs, words }], meta }
// where words is [[word, startMs, endMs], ...]. The minimal karaoke reader
// consumes it directly; the vaepack persists it; retro-extraction later joins
// the line texts into `body_text` and runs the normal scenes/characters
// pipeline over it.
//
// onLinesReady fires per chunk row (newly transcribed sentences only, globally
// indexed and contiguous) so the reader can start on the first ~4 minutes while
// the rest streams in. The Promise resolves with the whole transcript once the
// server's "done" row arrives.

export const TRANSCRIBE_MARKER = "whisperx-transcribe";

/**
 * Read a fetch Response body as NDJSON, calling onLine for each parsed object
 * as its line completes. Falls back to whole-text splitting where the body
 * isn't a readable stream (some test fetches).
 *
 * `onLine` is awaited before the next line is processed — callers persist a
 * checkpoint per row (checkpointM4bFirstProgress) into the SAME local pack
 * record appendM4bFirstLines writes to; letting two rows' writes race was a
 * real bug (last-write-wins could silently revert an already-saved line or
 * drop a checkpoint, both indistinguishable from "resume didn't work").
 */
async function readNdjson(res, onLine) {
  const reader = res.body?.getReader?.();
  if (!reader) {
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

/** Normalize a server line row into the reader/pack line shape. */
function toReaderLine(row) {
  const startMs = Math.round(row.start_ms || 0);
  const endMs = Math.max(startMs, Math.round(row.end_ms || startMs));
  return {
    idx: row.idx,
    text: row.text || "",
    startMs,
    endMs,
    // [[word, startMs, endMs], ...] — already ms from the server.
    words: Array.isArray(row.words) ? row.words : [],
  };
}

/**
 * Transcribe an attached .m4b via the local align server's /transcribe mode.
 *
 * @param {Object} input
 * @param {Blob} input.blob                    The audiobook file.
 * @param {{baseUrl:string}} input.connection  Local align server (from backends/connections.js).
 * @param {string} [input.bookId]
 * @param {string} [input.title]
 * @param {(newLines: Array, processedMs:number, totalMs:number) => void} [input.onLinesReady]
 *        Fired once per chunk row that produced new sentences.
 * @param {(processedMs:number, totalMs:number) => void} [input.onProgress]
 * @param {number} [input.resumeMs]   Skip straight to this offset — a prior run
 *        already covered everything before it (see checkpointM4bFirstProgress).
 * @param {number} [input.resumeIdx]  Line index to continue numbering from,
 *        matching resumeMs (normally the count of already-saved lines).
 * @param {typeof fetch} [input.fetchImpl]      Injectable for tests.
 * @returns {Promise<{bookId:string,title:string,durationMs:number,lines:Array,meta:object}>}
 */
export async function transcribeM4b({
  blob, connection, bookId = "book", title = "", onLinesReady, onProgress,
  resumeMs = 0, resumeIdx = 0, fetchImpl,
}) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) throw new Error("transcribeM4b: no fetch implementation available");
  if (!connection?.baseUrl) throw new Error("transcribeM4b: no align server connection selected");

  const form = new FormData();
  form.append("m4b", blob, "audiobook");
  if (resumeMs > 0) {
    form.append("resume_ms", String(Math.round(resumeMs)));
    form.append("resume_idx", String(Math.round(resumeIdx)));
  }

  const base = String(connection.baseUrl).replace(/\/$/, "");
  const res = await doFetch(`${base}/transcribe`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`transcribe server: HTTP ${res.status}`);

  const lines = [];
  let durationMs = 0;
  let meta = {};
  let sawDone = false;
  let streamErr = null;

  await readNdjson(res, async (row) => {
    if (row.status === "error") {
      streamErr = row.error || "transcription failed";
      return;
    }
    if (row.total_ms) durationMs = row.total_ms;
    if (row.status === "chunk") {
      if (row.meta) meta = row.meta;
      const newLines = (row.lines || []).map(toReaderLine);
      if (newLines.length) {
        lines.push(...newLines);
        // Awaited in order — onLinesReady and onProgress both write the SAME
        // local pack record; running them concurrently (or racing across
        // rows) risks a stale read-modify-write clobbering the other's write.
        await onLinesReady?.(newLines, row.processed_ms, row.total_ms);
      }
      await onProgress?.(row.processed_ms, row.total_ms);
      return;
    }
    if (row.status === "done") {
      if (row.meta) meta = row.meta;
      sawDone = true;
    }
  });

  if (!sawDone) throw new Error(streamErr || "transcribe server: stream ended without a result");

  // Contiguity guard: the reader indexes lines by array position, so a gap or
  // dupe in server-assigned idx would silently misalign the karaoke highlight.
  lines.sort((a, b) => a.idx - b.idx);
  lines.forEach((ln, i) => { ln.idx = i; });

  return { bookId, title, durationMs, lines, meta };
}
