// API root — Settings override, build env, or same-origin when co-hosted.
// Copied pattern from the parallel-reader (api.js).
import { getLocalApiBridge } from "./localApiBridge.js";

function coHostedApiBase() {
  if (typeof window === "undefined") return "";
  const p = window.location.pathname;
  if (p.startsWith("/projects/ebookavplayer/") || p === "/projects/ebookavplayer") {
    return "/projects/ebookavplayer/api";
  }
  return "";
}

export function apiBase() {
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

export function apiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = apiBase();
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

export async function fetchBook(id, { timeoutMs } = {}) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(id)}`), {
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
} = {}) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("art_style", artStyle);
  fd.append("narrator_gender", narratorGender);
  fd.append("dry_run", dryRun ? "true" : "false");
  fd.append("generate_art", generateArt ? "true" : "false");
  fd.append("byo_mode", byoMode ? "true" : "false");
  const res = await fetch(apiUrl("/ingest"), { method: "POST", body: fd });
  if (!res.ok) throw new Error(`ingest: HTTP ${res.status}`);
  return res.json();
}

// Catalog doubles as the per-book processing status feed (status/progress/cover).
export async function fetchCatalog() {
  const res = await fetch(apiUrl("/books"), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
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
    debug_log: ev.debug_log,
    error: ev.error,
  };
}

export async function fetchPipeline() {
  const res = await fetch(apiUrl("/pipeline"), { signal: AbortSignal.timeout(8000) });
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

export async function revertMediaAsset(bookId, kind, key, { style } = {}) {
  const body = { kind, key };
  if (style) body.style = style;
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/media/revert`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`revert: HTTP ${res.status}`);
  return res.json();
}

export async function commitMediaAsset(bookId, kind, key, { style } = {}) {
  const body = { kind, key };
  if (style) body.style = style;
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

export async function reExtractBook(bookId, { force = false } = {}) {
  const q = force ? "?force=true" : "";
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/re-extract${q}`), {
    method: "POST",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`re-extract: HTTP ${res.status}`);
  return res.json();
}

export async function replaceMedia(bookId, opts = {}) {
  async function post() {
    return fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/generate-media`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
      signal: fetchSignal(8000),
    });
  }

  let res = await post();
  if (res.status === 409) {
    await unlockImaging(bookId, { force: true }).catch(() => {});
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

export async function unlockImaging(bookId, { force = false } = {}) {
  const q = force ? "?force=true" : "";
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/imaging/unlock${q}`), {
    method: "POST",
    signal: fetchSignal(8000),
  });
  if (!res.ok) throw new Error(`imaging/unlock: HTTP ${res.status}`);
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
