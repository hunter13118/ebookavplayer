// Persists the single shared .m4b audiobook a user attaches to a book, so it
// survives a page reload without re-prompting for the file. Reuses the
// existing generic blob + settings stores (packStore.js) under a fixed key
// namespace — no new IndexedDB object store or version bump needed.
import { putBlob, getBlob, deleteBlob, putSetting, getSetting, deleteSetting } from "./packStore.js";

const M4B_PATH = "m4b/audiobook.m4b";
const nameKey = (bookId) => `m4b-name::${bookId}`;

/** Store (or replace) the attached .m4b Blob + its original filename for a book. */
export async function storeM4b(bookId, blob, fileName) {
  await putBlob(bookId, M4B_PATH, blob);
  if (fileName) await putSetting(nameKey(bookId), fileName);
}

/** Load the previously-attached .m4b Blob for a book, or null if none. */
export async function loadM4b(bookId) {
  return getBlob(bookId, M4B_PATH);
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
