/** EPUB illustration plate catalog from playback / analysis fields. */

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

/** Map plate index → list of character names using it as reference. */
export function plateAssignmentMap(book) {
  const map = new Map();
  const coverRef = book?.cover_illustration_ref;
  if (coverRef != null) {
    map.set(coverRef, ["Cover"]);
  }
  for (const [id, c] of Object.entries(book?.characters || {})) {
    if (id === "narrator") continue;
    const ref = c?.illustration_ref;
    if (ref == null) continue;
    const list = map.get(ref) || [];
    list.push(c.name || id);
    map.set(ref, list);
  }
  return map;
}

export function characterIllustrationRefs(book) {
  const out = {};
  for (const [id, c] of Object.entries(book?.characters || {})) {
    if (id === "narrator") continue;
    if (c?.illustration_ref != null) out[id] = c.illustration_ref;
  }
  return out;
}
