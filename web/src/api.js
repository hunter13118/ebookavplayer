// API root — Settings override, build env, or same-origin when co-hosted.
// Copied pattern from the parallel-reader (api.js).
export function apiBase() {
  const stored =
    (typeof localStorage !== "undefined" && localStorage.getItem("vae-api-base")) ||
    (import.meta && import.meta.env && import.meta.env.VITE_API_BASE);
  if (stored) return String(stored).replace(/\/$/, "");
  // Same-origin relative paths — in dev, vite.config.js proxies /books, /ingest, …
  // to FastAPI. Do NOT fall back to window.location.origin: Vite would return
  // index.html (HTTP 200) and res.json() would throw → "backend unreachable".
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

export async function fetchBooks() {
  const res = await fetch(apiUrl("/books"), { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`books: HTTP ${res.status}`);
  return res.json();
}

export async function fetchBook(id) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(id)}`));
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
  artStyle = "semi-real", narratorGender = "male", dryRun = false, generateArt = true,
} = {}) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("art_style", artStyle);
  fd.append("narrator_gender", narratorGender);
  fd.append("dry_run", dryRun ? "true" : "false");
  fd.append("generate_art", generateArt ? "true" : "false");
  const res = await fetch(apiUrl("/ingest"), { method: "POST", body: fd });
  if (!res.ok) throw new Error(`ingest: HTTP ${res.status}`);
  return res.json();
}

// Catalog doubles as the per-book processing status feed (status/progress/cover).
export async function fetchCatalog() {
  const res = await fetch(apiUrl("/books"), { signal: AbortSignal.timeout(5000) });
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
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`generate-style: HTTP ${res.status}`);
  return res.json();
}

export async function discardArtStyle(bookId, style) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/styles/${encodeURIComponent(style)}`), {
    method: "DELETE",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`delete-style: HTTP ${res.status}`);
  return res.json();
}

export async function replaceMedia(bookId, opts = {}) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/generate-media`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`generate-media: HTTP ${res.status}`);
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
