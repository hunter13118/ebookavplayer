/** Collect illustration / visual-insert moments from a compiled book (spoiler-safe). */

/** Build inserts map from playback root + per-line illustration_url fields. */
export function harvestInsertMap(book) {
  const inserts = { ...(book?.inserts || {}) };
  for (const scene of book?.scenes || []) {
    for (const line of scene.lines || []) {
      const url = line?.illustration_url;
      if (url && String(url).startsWith("/media/")) {
        inserts[String(line.idx)] = url;
      }
    }
  }
  return inserts;
}

/** Strip a cache-busting `?v=...` query so the same asset dedupes regardless
 *  of which version token a given book field happens to carry. */
function baseUrl(url) {
  return String(url || "").split("?")[0];
}

/**
 * The book's OWN embedded art — the cover and every raster image the EPUB
 * shipped with (worker/_shared/epub-images.js -> `illustration_urls`, an
 * {index: url} map in reading order; `cover` is the catalog thumbnail). These
 * exist for EVERY book with images regardless of extraction path — crucially
 * including BookNLP-processed books, whose scene lines carry NO
 * `illustration_url` at all (booknlp-script.js attaches none), which is why
 * the gallery was empty for them even though the front-matter plates rendered
 * inline. Unlike generated per-line "moments", embedded plates have no story
 * position to spoiler-gate against and are already interleaved in the pages
 * the reader is turning, so they're always listed (sorted by their in-book
 * index, cover first).
 */
function embeddedIllustrations(book, seen) {
  const items = [];
  const coverBase = baseUrl(book?.cover);
  if (coverBase && coverBase.startsWith("/media/") && !seen.has(coverBase)) {
    seen.add(coverBase);
    items.push({
      id: "cover", url: book.cover, lineIdx: null, chapter: null, sceneTitle: "",
      caption: "Cover", speaker: "", isMoment: false, isEmbedded: true, order: -1,
    });
  }
  const map = book?.illustration_urls || {};
  for (const [idx, url] of Object.entries(map)) {
    const base = baseUrl(url);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    const n = Number(idx);
    items.push({
      id: `img-${idx}`, url, lineIdx: null, chapter: null, sceneTitle: "",
      caption: `Book illustration ${Number.isFinite(n) ? n + 1 : idx}`,
      speaker: "", isMoment: false, isEmbedded: true, order: Number.isFinite(n) ? n : 0,
    });
  }
  return items.sort((a, b) => a.order - b.order);
}

/**
 * @param {object} book compiled playback book
 * @param {number} unlockedMaxLine highest line index the reader has reached (inclusive)
 */
export function collectIllustrations(book, unlockedMaxLine = Infinity) {
  const items = [];
  const seen = new Set();
  const cap = Number.isFinite(unlockedMaxLine) ? unlockedMaxLine : Infinity;
  const momentKeys = book?.inserts || {};

  (book?.scenes || []).forEach((scene) => {
    (scene.lines || []).forEach((line) => {
      if (line.idx > cap) return;
      const url = line.illustration_url;
      if (!url || seen.has(baseUrl(url))) return;
      seen.add(baseUrl(url));
      const isMoment = Boolean(momentKeys[String(line.idx)]);
      items.push({
        id: `line-${line.idx}`,
        url,
        lineIdx: line.idx,
        chapter: scene.chapter,
        sceneTitle: scene.title || "",
        caption: line.illustration_caption || line.text?.slice(0, 80) || "Illustration",
        speaker: line.speaker_name || line.character_id || "",
        isMoment,
      });
    });
  });
  const lineItems = items.sort((a, b) => a.lineIdx - b.lineIdx);
  // Embedded book art (cover + EPUB plates) first, then story-positioned
  // moments in reading order. `seen` (base URLs) is shared so a plate that a
  // line DID attach isn't listed twice.
  return [...embeddedIllustrations(book, seen), ...lineItems];
}

