/** Per-connection collapse state for the library's grouped-by-backend sections. */

const KEY = "vae-library-section-collapse";

function readMap() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeMap(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch { /* quota */ }
}

/** @returns {boolean|undefined} undefined when the user has never toggled this section. */
export function getSectionCollapsed(connectionId) {
  return readMap()[connectionId];
}

export function setSectionCollapsed(connectionId, collapsed) {
  const map = readMap();
  map[connectionId] = collapsed;
  writeMap(map);
}

/** Default-expanded for a lone/small section, default-collapsed once 3+ sections compete for space. */
export function defaultCollapsed(sectionCount, bookCount) {
  if (sectionCount <= 1) return false;
  if (bookCount < 10) return false;
  return sectionCount >= 3;
}
