// API root — Settings override, build env, or same-origin when co-hosted.
// Copied pattern from the parallel-reader (api.js).
import { getLocalApiBridge } from "./localApiBridge.js";
import { getActiveConnection } from "./backends/connections.js";

function coHostedApiBase() {
  if (typeof window === "undefined") return "";
  const p = window.location.pathname;
  if (p.startsWith("/projects/ebookavplayer/") || p === "/projects/ebookavplayer") {
    return "/projects/ebookavplayer/api";
  }
  return "";
}

export function apiBase(connection) {
  const conn = connection || getActiveConnection();
  if (conn) {
    if (conn.kind === "offline") return "";
    return String(conn.baseUrl || "").replace(/\/$/, "");
  }
  const stored =
    getLocalApiBridge() ||
    (import.meta && import.meta.env && import.meta.env.VITE_API_BASE) ||
    coHostedApiBase();
  if (stored) return String(stored).replace(/\/$/, "");
  // Same-origin relative paths — in dev, vite.config.js proxies /books, /ingest, …
  // to local edge (wrangler) or FastAPI. Do NOT fall back to window.location.origin:
  // Vite would return index.html (HTTP 200) and res.json() would throw.
  return "";
}

/** Should the client attempt /books, /ingest, /tts? (Empty apiBase still counts — proxy.) */
export function backendConfigured() {
  if (typeof window === "undefined") return false;
  return true;
}

export function apiUrl(path, connection) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = apiBase(connection);
  return base ? `${base}${p}` : p;
}

/** Optional fetch abort; omit timeoutMs for long-running imaging/job polls. */
export function fetchSignal(timeoutMs) {
  if (!timeoutMs || typeof AbortSignal === "undefined" || !AbortSignal.timeout) {
    return undefined;
  }
  return AbortSignal.timeout(timeoutMs);
}

export async function fetchBooks() {
  const res = await fetch(apiUrl("/books"), { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`books: HTTP ${res.status}`);
  return res.json();
}

export async function fetchBook(id, { timeoutMs, connection } = {}) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(id)}`, connection), {
    signal: fetchSignal(timeoutMs),
  });
  if (!res.ok) throw new Error(`book ${id}: HTTP ${res.status}`);
  return res.json();
}

export async function fetchEdgeVoices(locale) {
  const q = locale ? `?locale=${encodeURIComponent(locale)}` : "";
  const res = await fetch(apiUrl(`/voices/edge${q}`), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`edge voices: HTTP ${res.status}`);
  return res.json();
}

// ---- Library / upload / resume (added for the landing page) ----

export async function ingestBook(file, {
  artStyle = "anime", narratorGender = "male", dryRun = false, generateArt = true, byoMode = false,
  generateExpressiveSprites = false, preferProvider = "auto", useBooknlp = true, useAnnotate = true, connection,
} = {}) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("art_style", artStyle);
  fd.append("narrator_gender", narratorGender);
  fd.append("dry_run", dryRun ? "true" : "false");
  fd.append("generate_art", generateArt ? "true" : "false");
  fd.append("byo_mode", byoMode ? "true" : "false");
  fd.append("generate_expressive_sprites", generateExpressiveSprites ? "true" : "false");
  fd.append("prefer_provider", preferProvider || "auto");
  fd.append("use_booknlp", useBooknlp ? "true" : "false");
  fd.append("use_annotate", useAnnotate ? "true" : "false");
  const res = await fetch(apiUrl("/ingest", connection), { method: "POST", body: fd });
  if (!res.ok) throw new Error(`ingest: HTTP ${res.status}`);
  return res.json();
}

// M4B-first "formal extraction" trigger (docs/M4B_FIRST_FLOW.md) — runs the
// normal scenes/characters/dialogue extraction over an already-transcribed
// M4B's text. bookId must match the book's existing local-only pack
// (m4bFirstBooks.js) so the result upgrades it in place.
export async function ingestBookText(bookId, { title, bodyText, artStyle = "anime", connection } = {}) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/ingest-text`, connection), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, body_text: bodyText, art_style: artStyle }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `ingest-text: HTTP ${res.status}`);
  }
  return res.json();
}

// Attach a real EPUB to a book that doesn't have one yet (e.g. an m4b-first
// audiobook-only upload, docs/M4B_FIRST_FLOW.md) — re-runs the SAME
// checkpointed extraction /ingest uses, targeted at the EXISTING book_id
// instead of minting a new one, so real chapter boundaries + any embedded
// illustrations replace the STT-derived text. `title` preserves the book's
// current catalog title (otherwise the worker would fall back to the epub's
// filename) — see worker/api/v1/ingest.js's `existing_book_id` handling.
export async function attachEpubToBook(bookId, file, {
  title, artStyle = "anime", narratorGender = "male", useBooknlp = true, useAnnotate = true, connection,
} = {}) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("existing_book_id", bookId);
  if (title) fd.append("title", title);
  fd.append("art_style", artStyle);
  fd.append("narrator_gender", narratorGender);
  fd.append("dry_run", "false");
  fd.append("generate_art", "true");
  fd.append("prefer_provider", "auto");
  fd.append("use_booknlp", useBooknlp ? "true" : "false");
  fd.append("use_annotate", useAnnotate ? "true" : "false");
  const res = await fetch(apiUrl("/ingest", connection), { method: "POST", body: fd });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `attach epub: HTTP ${res.status}`);
  }
  return res.json();
}

// Resume a stalled/partial book (e.g. free-tier quota exhausted mid-book)
// from its last checkpointed chapter, optionally pinning/swapping the
// extraction provider for the rest of the book.
export async function continueExtraction(bookId, { preferProvider = "auto", connection } = {}) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/continue-extract`, connection), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefer_provider: preferProvider || "auto" }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `continue-extract: HTTP ${res.status}`);
  }
  return res.json();
}

// Catalog doubles as the per-book processing status feed (status/progress/cover).
export async function fetchCatalog(connection) {
  const res = await fetch(apiUrl("/books", connection), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
  return res.json();
}

/** Cheap liveness probe — already-existing GET /health, used to decide whether
 *  a connection's section should render in the Library at all. */
export async function fetchHealth(connection) {
  const res = await fetch(apiUrl("/health", connection), { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`health: HTTP ${res.status}`);
  return res.json();
}

export async function setActiveStyle(bookId, style, { mode } = {}) {
  const body = { style };
  if (mode) body.mode = mode;
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/active-style`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`active-style: HTTP ${res.status}`);
  return res.json();
}

export async function generateArtStyle(bookId, style) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/styles/${encodeURIComponent(style)}`), {
    method: "POST",
    signal: fetchSignal(8000),
  });
  if (!res.ok) throw new Error(`generate-style: HTTP ${res.status}`);
  const data = await res.json();
  if (data?.status !== "already_ready" && !data?.job_id) {
    throw new Error("generate-style: no job id in response");
  }
  return data;
}

export async function discardArtStyle(bookId, style) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/styles/${encodeURIComponent(style)}`), {
    method: "DELETE",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`delete-style: HTTP ${res.status}`);
  return res.json();
}

/** @deprecated Debug/admin only — clients must use subscribeJobEvents (SSE). */
export async function fetchJobStatus(jobId) {
  const res = await fetch(apiUrl(`/ingest/${encodeURIComponent(jobId)}`), {
    signal: fetchSignal(12000),
  });
  if (!res.ok) throw new Error(`job status: HTTP ${res.status}`);
  return res.json();
}

/** Subscribe to job lifecycle events via SSE — one long-lived connection, no polling. */
export function subscribeJobEvents(jobId, { onEvent, onError } = {}) {
  if (typeof EventSource === "undefined") {
    onError?.(new Error("EventSource not supported"));
    return () => {};
  }

  let es;
  let closed = false;
  let reconnectTimer;
  let reconnects = 0;
  const maxReconnects = 12;
  let backoff = 5000;
  const maxBackoff = 60_000;

  function connect() {
    es = new EventSource(apiUrl(`/ingest/${encodeURIComponent(jobId)}/events`));
    es.onmessage = (ev) => {
      backoff = 5000;
      reconnects = 0;
      try {
        onEvent?.(JSON.parse(ev.data));
      } catch (e) {
        onError?.(e);
      }
    };
    es.onerror = () => {
      es?.close();
      if (closed) return;
      reconnects += 1;
      if (reconnects > maxReconnects) {
        onError?.(new Error("SSE connection lost"));
        return;
      }
      reconnectTimer = setTimeout(() => {
        if (!closed) connect();
      }, backoff);
      backoff = Math.min(maxBackoff, backoff * 1.5);
    };
  }

  connect();
  return () => {
    closed = true;
    clearTimeout(reconnectTimer);
    es?.close();
  };
}

/** Map SSE event payload to fetchJobStatus-shaped object. */
export function jobEventToStatus(ev) {
  if (!ev || typeof ev !== "object") return {};
  let status = ev.status;
  if (ev.type === "done") status = "done";
  else if (ev.type === "error") status = "error";
  else if (ev.type === "queued") status = "queued";
  return {
    status,
    stage: ev.stage,
    progress: ev.progress,
    detail: ev.detail,
    step_index: ev.step_index,
    step_total: ev.step_total,
    comparisons: ev.comparisons,
    phase: ev.phase,
    phase_label: ev.phase_label,
    step: ev.step,
    progress_meta: ev.progress_meta,
    workers: ev.workers,
    debug_log: ev.debug_log,
    error: ev.error,
  };
}

export async function fetchPipeline(connection) {
  const res = await fetch(apiUrl("/pipeline", connection), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`pipeline: HTTP ${res.status}`);
  return res.json();
}

export async function patchPipeline(lanes) {
  const res = await fetch(apiUrl("/pipeline"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lanes }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`pipeline: HTTP ${res.status}`);
  return res.json();
}

export async function applyCostEfficientPipeline() {
  const res = await fetch(apiUrl("/pipeline"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apply_cost_efficient: true }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`pipeline: HTTP ${res.status}`);
  return res.json();
}

export async function applyLocalExtractPreset(presetId) {
  const res = await fetch(apiUrl("/pipeline"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apply_local_extract_preset: presetId }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`pipeline: HTTP ${res.status}`);
  return res.json();
}

export async function revertMediaAsset(bookId, kind, key, { style, jobId } = {}) {
  const body = { kind, key };
  if (style) body.style = style;
  if (jobId) body.job_id = jobId;
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/media/revert`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`revert: HTTP ${res.status}`);
  return res.json();
}

export async function commitMediaAsset(bookId, kind, key, { style, jobId } = {}) {
  const body = { kind, key };
  if (style) body.style = style;
  if (jobId) body.job_id = jobId;
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/media/commit`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`commit: HTTP ${res.status}`);
  return res.json();
}

export async function previewEdgeVoice(
  text = "The quick brown fox jumps over the lazy dog.",
  { voice, pitch, rate, volume } = {},
) {
  const body = { text, voice };
  if (pitch) body.pitch = pitch;
  if (rate) body.rate = rate;
  if (volume) body.volume = volume;
  const res = await fetch(apiUrl("/tts"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || res.status === 204) throw new Error(`preview: HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob?.size) throw new Error("preview: empty audio");
  const url = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => {
      const audio = new Audio(url);
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("preview playback failed"));
      audio.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function reExtractBook(bookId, { force = false, preferProvider, connection } = {}) {
  const params = new URLSearchParams();
  if (force) params.set("force", "true");
  if (preferProvider && preferProvider !== "auto") params.set("prefer_provider", preferProvider);
  const q = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/re-extract${q}`, connection), {
    method: "POST",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`re-extract: HTTP ${res.status}`);
  return res.json();
}

export async function runExpressionRepass(bookId, { preferProvider, connection } = {}) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/expression-repass`, connection), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefer_provider: preferProvider && preferProvider !== "auto" ? preferProvider : null }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`expression-repass: HTTP ${res.status}`);
  return res.json();
}

export async function regenExpressionSprite(bookId, characterId, bucket, { connection } = {}) {
  const res = await fetch(
    apiUrl(`/books/${encodeURIComponent(bookId)}/characters/${encodeURIComponent(characterId)}/expressions/regen`, connection),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bucket }),
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = err?.error || "";
    } catch { /* empty */ }
    throw new Error(detail || `expressions/regen: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data?.job_id) throw new Error("expressions/regen: no job id in response");
  return data;
}

export async function replaceMedia(bookId, opts = {}) {
  const { connection, ...body } = opts;
  async function post() {
    return fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/generate-media`, connection), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: fetchSignal(8000),
    });
  }

  let res = await post();
  if (res.status === 409) {
    await unlockImaging(bookId, { force: true, connection }).catch(() => {});
    res = await post();
  }
  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = err?.error || "";
    } catch { /* empty */ }
    throw new Error(detail || `generate-media: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data?.job_id) throw new Error("generate-media: no job id in response");
  return data;
}

export async function generateMomentIllustration(bookId, { lineIdx, tweakScript = true, diversify = false } = {}) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/moments/generate`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      line_idx: lineIdx,
      tweak_script: tweakScript,
      diversify,
    }),
    signal: fetchSignal(8000),
  });
  if (!res.ok) throw new Error(`moments/generate: HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.job_id) throw new Error("moments/generate: no job id in response");
  return data;
}

export async function pollIngestJob(jobId) {
  throw new Error("pollIngestJob removed — use subscribeJobEvents");
}

/** jobId, when passed, scopes the unlock to that specific job — the server
 * refuses (no-ops) if the book's currently active job doesn't match. Root
 * cause of a real, confirmed-live bug: without this, a caller with stale
 * client-side job-tracking state (e.g. a browser tab that's been open
 * across several regen attempts) could force-unlock and stale-mark a
 * DIFFERENT, still-legitimately-running job just because IT was the one
 * active on the book when the stale caller's own (unrelated, already-dead)
 * job finally reported an error. Omit jobId for the "clear whatever's
 * currently stuck, I don't know or care what it is" case (e.g. retrying
 * after a 409 conflict). */
export async function unlockImaging(bookId, { force = false, jobId, connection } = {}) {
  const params = [];
  if (force) params.push("force=true");
  if (jobId) params.push(`job_id=${encodeURIComponent(jobId)}`);
  const q = params.length ? `?${params.join("&")}` : "";
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/imaging/unlock${q}`, connection), {
    method: "POST",
    signal: fetchSignal(8000),
  });
  if (!res.ok) throw new Error(`imaging/unlock: HTTP ${res.status}`);
  return res.json();
}

/** Stop treating a stuck/in-flight job as active — see onCancelProcessingPost
 *  for what this can and can't do (no queue cancel primitive, so it can't
 *  interrupt a running consumer invocation, only mark it terminal). */
export async function cancelProcessing(bookId, { connection } = {}) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/cancel-processing`, connection), {
    method: "POST",
    signal: fetchSignal(8000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `cancel-processing: HTTP ${res.status}`);
  }
  return res.json();
}

/** @deprecated use replaceMedia */
export const regenerateMedia = replaceMedia;

export async function uploadMedia(bookId, kind, key, file) {
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("key", key);
  fd.append("file", file);
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/media/upload`), {
    method: "POST",
    body: fd,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`upload: HTTP ${res.status}`);
  return res.json();
}

export async function saveIllustrationRefs(bookId, body) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/illustration-refs`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`illustration-refs: HTTP ${res.status}`);
  return res.json();
}

export async function backfillIllustrations(bookId) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/illustrations/backfill`), {
    method: "POST",
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`illustrations/backfill: HTTP ${res.status}`);
  return res.json();
}

export async function matchIllustrationsToCharacters(bookId) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/illustrations/match-characters`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`illustrations/match-characters: HTTP ${res.status}`);
  return res.json();
}

export async function saveExternalRefs(bookId, body) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/external-refs`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`external-refs: HTTP ${res.status}`);
  return res.json();
}

export async function saveVoiceOverrides(bookId, overrides) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/voices`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(overrides),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`voices: HTTP ${res.status}`);
  return res.json();
}

export async function mergeCharacter(bookId, { from, to }) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/characters/merge`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, to }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`character merge: HTTP ${res.status}`);
  return res.json();
}

export async function renameCharacter(bookId, { id, name }) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/characters/rename`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`character rename: HTTP ${res.status}`);
  return res.json();
}

export async function renameBook(bookId, title) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/title`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`book rename: HTTP ${res.status}`);
  return res.json();
}

export async function setCharacterTemperament(bookId, { id, temperament }) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/characters/temperament`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, temperament }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`character temperament: HTTP ${res.status}`);
  return res.json();
}

export async function setCharacterDescription(bookId, { id, description }) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/characters/description`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, description }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`character description: HTTP ${res.status}`);
  return res.json();
}

export async function setCharacterIsHumanoid(bookId, { id, is_humanoid }) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/characters/is-humanoid`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, is_humanoid }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`character is-humanoid: HTTP ${res.status}`);
  return res.json();
}

export async function setCharacterWantsExpressions(bookId, { id, wants_expressions }) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/characters/wants-expressions`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, wants_expressions }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`character wants-expressions: HTTP ${res.status}`);
  return res.json();
}

export async function uploadCharacterReferenceImage(bookId, charId, file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(
    apiUrl(`/books/${encodeURIComponent(bookId)}/characters/${encodeURIComponent(charId)}/reference-image`),
    { method: "POST", body: form, signal: AbortSignal.timeout(30000) },
  );
  if (!res.ok) throw new Error(`character reference image: HTTP ${res.status}`);
  return res.json();
}

/** Detach one reference image from a character — the R2 object stays
 * (cheap; re-attachable via assignCharacterReferenceImage below). */
export async function removeCharacterReferenceImage(bookId, charId, url) {
  const res = await fetch(
    apiUrl(`/books/${encodeURIComponent(bookId)}/characters/${encodeURIComponent(charId)}/reference-image`),
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(12000),
    },
  );
  if (!res.ok) throw new Error(`character reference image delete: HTTP ${res.status}`);
  return res.json();
}

/** Attach an already-stored crop (e.g. another character's mismatched
 * reference) to this character instead of uploading a new file. */
export async function assignCharacterReferenceImage(bookId, charId, url) {
  const res = await fetch(
    apiUrl(`/books/${encodeURIComponent(bookId)}/characters/${encodeURIComponent(charId)}/reference-image/assign`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(12000),
    },
  );
  if (!res.ok) throw new Error(`character reference image assign: HTTP ${res.status}`);
  return res.json();
}

/** Every reference crop currently attached to any character in the book,
 * tagged by current owner — powers the "pick from existing crops" picker. */
export async function getCharacterCrops(bookId) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/character-crops`), {
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`character crops: HTTP ${res.status}`);
  return res.json();
}

export async function postResume(bookId, pos) {
  try {
    await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/progress`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pos),
      signal: AbortSignal.timeout(4000),
    });
  } catch { /* resume sync is best-effort; localStorage is the source of truth */ }
}
