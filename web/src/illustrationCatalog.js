/**
 * EPUB illustration plate catalog from playback / analysis fields — used
 * only for the cover-art plate picker (EpubPlatesSheet.jsx) now. Per-
 * character plate assignment was removed (2026-07-10): a raw plate is
 * rarely a clean single-character portrait, see CropCatalog.jsx and
 * illustrations.js's applyDirectIllustrations docstring for why crops
 * replaced it as the "who is this" unit.
 */
export function listIllustrationPlates(book) {
  const urls = book?.illustration_urls || {};
  return Object.entries(urls)
    .map(([idx, url]) => ({
      index: parseInt(idx, 10),
      url: String(url),
      label: idx === String(book?.cover_illustration_ref) ? `Plate ${idx} (cover)` : `Plate ${idx}`,
    }))
    .filter((p) => !Number.isNaN(p.index))
    .sort((a, b) => a.index - b.index);
}
