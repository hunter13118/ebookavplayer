// Caches a computed alignment manifest (a TimingResult) so re-attaching the
// same .m4b to the same book doesn't re-run a genuinely multi-minute
// computation (WhisperX ASR + forced alignment) on every load. Reuses the
// generic settings store (packStore.js) — no new IndexedDB object store or
// version bump needed, same pattern as m4bStore.js.
import { putSetting, getSetting, deleteSetting } from "./packStore.js";

const manifestKey = (bookId, algorithmId) => `align-manifest::${bookId}::${algorithmId}`;

/**
 * Cheap fingerprint of "what was aligned": the m4b's byte size plus the
 * book's total line count and character count. Catches both "a different
 * m4b was attached" and "the book was re-extracted with different lines" —
 * a full content hash isn't needed since a false cache hit just means an
 * unnecessary re-align, not silent corruption (the manifest itself carries
 * the real lineIndex keys, so a stale-but-matching-fingerprint manifest
 * would only ever mistime lines, never crash).
 */
function fingerprint(blobSize, slidesByChapter) {
  let lineCount = 0;
  let charCount = 0;
  for (const ch of slidesByChapter || []) {
    for (const s of ch.slides || []) {
      lineCount += 1;
      charCount += s.charCount || 0;
    }
  }
  return `${blobSize || 0}:${lineCount}:${charCount}`;
}

/** Persist a computed alignment manifest for a book + algorithm. */
export async function storeAlignManifest(bookId, algorithmId, blobSize, slidesByChapter, result) {
  await putSetting(manifestKey(bookId, algorithmId), {
    fingerprint: fingerprint(blobSize, slidesByChapter),
    result,
    storedAt: Date.now(),
  });
}

/**
 * Load a previously-cached manifest, or null if none exists or the
 * fingerprint no longer matches (different m4b / different extracted lines).
 */
export async function loadAlignManifest(bookId, algorithmId, blobSize, slidesByChapter) {
  const record = await getSetting(manifestKey(bookId, algorithmId));
  if (!record) return null;
  if (record.fingerprint !== fingerprint(blobSize, slidesByChapter)) return null;
  return record.result;
}

/** Remove a book's cached manifest for an algorithm (e.g. on m4b removal, or a forced re-align). */
export async function removeAlignManifest(bookId, algorithmId) {
  await deleteSetting(manifestKey(bookId, algorithmId));
}
