// Persists the single shared .m4b audiobook a user attaches to a book, so it
// survives a page reload without re-prompting for the file. Reuses the
// existing generic blob + settings stores (packStore.js) under a fixed key
// namespace — no new IndexedDB object store or version bump needed.
import { putBlob, getBlob, deleteBlob, putSetting, getSetting, deleteSetting } from "./packStore.js";

const M4B_PATH = "m4b/audiobook.m4b";
const nameKey = (bookId) => `m4b-name::${bookId}`;
const AUDIO_MIME_TYPES = ["audio/mp4", "audio/x-m4a", "audio/m4b", "audio/aac", "audio/mpeg"];

/** Many browsers/OSes have no registered MIME mapping for the .m4b extension
 *  specifically (unlike .mp3) — a file picked via <input accept=".m4b">
 *  frequently comes through with an empty `file.type`. packStore.js's
 *  blobToStored() then defaults that to "application/octet-stream", which
 *  many browsers' <audio> element silently refuses to play even though the
 *  underlying AAC-in-MP4 audio is perfectly valid — the reader/text still
 *  renders fine (unaffected by blob type), only playback goes silent, which
 *  is exactly the confusing "UI works, audio doesn't" symptom this fixes.
 *  Re-wrapping (not mutating — Blob/File.type is read-only) with a real
 *  audio MIME type is a no-op for a browser that already guessed right, and
 *  is cheap: the Blob constructor references the original bytes rather than
 *  copying them, so this doesn't double memory for a large audiobook file. */
function normalizeM4bType(blob) {
  if (AUDIO_MIME_TYPES.includes(blob.type)) return blob;
  return new Blob([blob], { type: "audio/mp4" });
}

/** Store (or replace) the attached .m4b Blob + its original filename for a book. */
export async function storeM4b(bookId, blob, fileName) {
  await putBlob(bookId, M4B_PATH, normalizeM4bType(blob));
  if (fileName) await putSetting(nameKey(bookId), fileName);
}

/** Load the previously-attached .m4b Blob for a book, or null if none.
 *  Also normalizes on the way OUT — anything stored before storeM4b started
 *  normalizing on the way IN (or via a path that bypassed it) still gets a
 *  playable MIME type without needing a re-upload. */
export async function loadM4b(bookId) {
  const blob = await getBlob(bookId, M4B_PATH);
  return blob ? normalizeM4bType(blob) : blob;
}

/** Load the original filename of the previously-attached .m4b, or null. */
export async function loadM4bName(bookId) {
  return getSetting(nameKey(bookId));
}

/** Remove a book's attached .m4b (blob + remembered filename). */
export async function removeM4b(bookId) {
  await deleteBlob(bookId, M4B_PATH);
  await deleteSetting(nameKey(bookId));
}
