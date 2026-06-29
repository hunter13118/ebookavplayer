/** Local shelves + sort for the library grid (iBooks-style). */

const SHELVES_KEY = "vae-library-shelves";
const ASSIGN_KEY = "vae-library-shelf-assign";
const SORT_KEY = "vae-library-sort";

export const SORT_TITLE = "title";
export const SORT_AUTHOR = "author";
export const SORT_RECENT = "recent";
export const SORT_PROGRESS = "progress";

export const ALL_SHELF_ID = "all";

const DEFAULT_SHELVES = [
  { id: ALL_SHELF_ID, name: "All Books" },
  { id: "reading", name: "Reading" },
  { id: "finished", name: "Finished" },
];

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* quota */ }
}

export function getShelves() {
  const custom = readJson(SHELVES_KEY, null);
  if (!custom?.length) return [...DEFAULT_SHELVES];
  const ids = new Set(custom.map((s) => s.id));
  if (!ids.has(ALL_SHELF_ID)) return [{ id: ALL_SHELF_ID, name: "All Books" }, ...custom];
  return custom;
}

export function saveShelves(shelves) {
  writeJson(SHELVES_KEY, shelves);
}

export function getShelfAssignments() {
  return readJson(ASSIGN_KEY, {});
}

export function assignBookToShelf(bookId, shelfId) {
  const map = getShelfAssignments();
  if (!shelfId || shelfId === ALL_SHELF_ID) {
    delete map[bookId];
  } else {
    map[bookId] = shelfId;
  }
  writeJson(ASSIGN_KEY, map);
  return map;
}

export function getSortMode() {
  return localStorage.getItem(SORT_KEY) || SORT_TITLE;
}

export function setSortMode(mode) {
  localStorage.setItem(SORT_KEY, mode);
}

export function filterByShelf(items, shelfId) {
  if (!shelfId || shelfId === ALL_SHELF_ID) return items;
  const map = getShelfAssignments();
  return items.filter((e) => map[e.book_id] === shelfId);
}

export function sortLibraryItems(items, mode = getSortMode()) {
  const list = [...items];
  const cmp = (a, b) => (a.title || "").localeCompare(b.title || "");
  if (mode === SORT_AUTHOR) {
    return list.sort((a, b) => cmp({ title: a.author }, { title: b.author }) || cmp(a, b));
  }
  if (mode === SORT_RECENT) {
    return list.sort((a, b) => (b.updated_at || b.installed_at || 0) - (a.updated_at || a.installed_at || 0));
  }
  if (mode === SORT_PROGRESS) {
    return list.sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0) || cmp(a, b));
  }
  return list.sort(cmp);
}
