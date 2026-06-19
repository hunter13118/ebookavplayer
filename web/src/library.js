// Resume + reading-progress state. localStorage is the source of truth (works
// offline, no auth); the server copy (/books/:id/progress) is a best-effort
// sync so position survives a cache clear. Tracks book + chapter + scene +
// line/slide, exactly the metadata needed to pick back up.
import { postResume } from "./api.js";

const KEY = (id) => `vae-resume-${id}`;

export function getResume(bookId) {
  try {
    const raw = localStorage.getItem(KEY(bookId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveResume(bookId, pos) {
  // pos: { line, sceneId, chapter, total }
  try { localStorage.setItem(KEY(bookId), JSON.stringify({ ...pos, updated: Date.now() })); } catch {}
  postResume(bookId, { line: pos.line | 0, sceneId: pos.sceneId || "", chapter: pos.chapter | 0 });
}

export function clearResume(bookId) {
  try { localStorage.removeItem(KEY(bookId)); } catch {}
}

/** Reading progress 0..1 for the library card. Prefers a server-provided
 *  resume, falls back to localStorage. */
export function readingFraction(bookId, totalLines, serverResume) {
  const r = serverResume || getResume(bookId);
  if (!r) return 0;
  if (r.completed) return 1;
  const total = totalLines || r.total || 0;
  if (!total) return 0;
  // line is 0-based index while playing; line === total means finished.
  return Math.min(1, (r.line || 0) / total);
}

/** Where to start playback: saved line if mid-book, else 0. */
export function resumeIndex(bookId, totalLines, serverResume) {
  const r = serverResume || getResume(bookId);
  if (!r) return 0;
  if (r.completed) return 0;
  const i = r.line | 0;
  return i > 0 && i < totalLines ? i : 0;
}
