// API root — Settings override, build env, or same-origin when co-hosted.
// Copied pattern from the parallel-reader (api.js).
export function apiBase() {
  const stored =
    (typeof localStorage !== "undefined" && localStorage.getItem("vae-api-base")) ||
    (import.meta && import.meta.env && import.meta.env.VITE_API_BASE);
  if (stored) return String(stored).replace(/\/$/, "");
  if (typeof window !== "undefined") {
    const { protocol, origin, hostname } = window.location;
    if (hostname && (protocol === "http:" || protocol === "https:")) return origin;
  }
  return "";
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

export async function ingestBook(file, { artStyle = "semi-real", narratorGender = "male", dryRun = false } = {}) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("art_style", artStyle);
  fd.append("narrator_gender", narratorGender);
  fd.append("dry_run", dryRun ? "true" : "false");
  const res = await fetch(apiUrl("/ingest"), { method: "POST", body: fd });
  if (!res.ok) throw new Error(`ingest: HTTP ${res.status}`);
  return res.json();            // { job_id, book_id, status }
}

// Catalog doubles as the per-book processing status feed (status/progress/cover).
export async function fetchCatalog() {
  const res = await fetch(apiUrl("/books"), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
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
