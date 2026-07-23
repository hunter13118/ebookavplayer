/**
 * Worker-side client for the local BookNLP server
 * (scripts/local-booknlp-server/server.py) — the mechanical (non-LLM)
 * character/dialogue/narration attribution pass, Slice 1 of
 * ~/.claude/plans/declarative-plotting-flamingo.md.
 *
 * Unlike the WhisperX align server (browser-driven, since the .m4b blob
 * lives on-device — see web/src/timing/whisperxAlignerClient.js), this is
 * called DIRECTLY from chapter-extract-pipeline.js: chapter text already
 * lives on the worker (R2, via epub-text.js), so there's no reason to route
 * it through the browser. This is the server-side mirror of that same
 * NDJSON-reading pattern.
 *
 * One HTTP call per chapter (not a whole-book batch) — matches the existing
 * per-chapter checkpoint granularity runCheckpointedExtraction already uses
 * for the LLM path, so a BookNLP failure on one chapter doesn't need any new
 * partial-batch bookkeeping; it just leaves that one chapter's mechanical
 * baseline (mechanical-script.js) in place, same as any other skipped
 * enrichment step.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:7862";
const PROCESS_TIMEOUT_MS = 120_000; // a single chapter is ~10-20s on CPU per a real spike; leaves headroom for longer chapters or a slower model tier

export function booknlpBaseUrl(env) {
  const raw = String(env?.VAE_BOOKNLP_URL || "").trim();
  return raw || null;
}

async function fetchWithTimeout(url, options, timeoutMs = PROCESS_TIMEOUT_MS, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Read a fetch Response body as NDJSON, calling onLine for each parsed
 * object as soon as its line completes — same pattern as
 * whisperxAlignerClient.js's readNdjson, mirrored here since the Workers
 * runtime doesn't share that module with the browser bundle. */
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

/**
 * Run one chapter through the local BookNLP server.
 * @returns {Promise<{characters: object[], lines: object[], meta: object} | null>}
 *   null if the server reported an "error" row for this chapter (caller
 *   falls back to leaving the mechanical baseline as-is — see module doc).
 */
export async function booknlpProcessChapter({
  baseUrl, bookId, chapterIndex, chapterTitle = "", chapterText, fetchImpl,
}) {
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const res = await fetchWithTimeout(`${base}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      book_id: bookId,
      chapters: [{ index: chapterIndex, title: chapterTitle, text: chapterText }],
    }),
  }, PROCESS_TIMEOUT_MS, fetchImpl);
  if (!res.ok) throw new Error(`booknlp server: HTTP ${res.status}`);

  let result = null;
  let streamErr = null;
  await readNdjson(res, async (row) => {
    if (row.status === "chunk") {
      result = { characters: row.characters || [], lines: row.lines || [], meta: row.meta || {} };
    } else if (row.status === "error") {
      streamErr = row.error || "booknlp processing failed";
    }
  });
  if (streamErr) throw new Error(`booknlp server: ${streamErr}`);
  return result;
}

export async function booknlpHealth({ baseUrl, fetchImpl } = {}) {
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(`${base}/health`);
  if (!res.ok) return { ok: false };
  return res.json();
}
