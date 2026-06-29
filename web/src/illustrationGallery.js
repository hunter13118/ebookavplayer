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
      if (!url || seen.has(url)) return;
      seen.add(url);
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
  return items.sort((a, b) => a.lineIdx - b.lineIdx);
}

