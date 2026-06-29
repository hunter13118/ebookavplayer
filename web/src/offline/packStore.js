/** IndexedDB storage for installed offline packs. */
import {
  blobKey, validateManifest, BOOK_NAME, VOICES_NAME, MEDIA_INDEX_NAME, AUDIO_MANIFEST_NAME,
} from "./packFormat.js";

const DB_NAME = "vae-offline";
const DB_VERSION = 2;
const PACKS = "packs";
const BLOBS = "blobs";
const SETTINGS = "settings";

let dbPromise = null;

/** Test-only: reset cached DB handle between vitest cases. */
export function resetPackStoreForTests() {
  dbPromise = null;
}

/** Test-only: wipe all installed packs without blocking on deleteDatabase. */
export async function clearAllPacksForTests() {
  resetPackStoreForTests();
  try {
    const db = await openDb();
    const names = [...db.objectStoreNames];
    if (!names.length) return;
    await new Promise((resolve, reject) => {
      const t = db.transaction(names, "readwrite");
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      for (const n of names) t.objectStore(n).clear();
    });
  } catch {
    /* first test — db not opened yet */
  }
}

async function blobToStored(blob) {
  return { buffer: await blob.arrayBuffer(), type: blob.type || "application/octet-stream" };
}

function storedToBlob(stored) {
  if (!stored) return null;
  if (stored instanceof Blob) return stored;
  if (stored.buffer) return new Blob([stored.buffer], { type: stored.type || "application/octet-stream" });
  return new Blob([stored]);
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(PACKS)) {
        db.createObjectStore(PACKS, { keyPath: "pack_id" });
      }
      if (!db.objectStoreNames.contains(BLOBS)) {
        db.createObjectStore(BLOBS);
      }
      if (!db.objectStoreNames.contains(SETTINGS)) {
        db.createObjectStore(SETTINGS, { keyPath: "key" });
      }
    };
  });
  return dbPromise;
}

export async function getSetting(key) {
  const { stores } = await tx([SETTINGS], "readonly");
  const row = await reqToPromise(stores[SETTINGS].get(key));
  return row?.value ?? null;
}

export async function putSetting(key, value) {
  const { stores, t } = await tx([SETTINGS], "readwrite");
  stores[SETTINGS].put({ key, value });
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(t.error);
  });
}

export async function deleteSetting(key) {
  const { stores, t } = await tx([SETTINGS], "readwrite");
  stores[SETTINGS].delete(key);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

function tx(storeNames, mode) {
  return openDb().then((db) => {
    const t = db.transaction(storeNames, mode);
    return { db, t, stores: Object.fromEntries(storeNames.map((n) => [n, t.objectStore(n)])) };
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listInstalledPacks() {
  const { stores } = await tx([PACKS], "readonly");
  return reqToPromise(stores[PACKS].getAll());
}

export async function getInstalledPack(packId) {
  const { stores } = await tx([PACKS], "readonly");
  return reqToPromise(stores[PACKS].get(packId));
}

export async function getInstalledPackForBook(bookId) {
  const all = await listInstalledPacks();
  return all.find((p) => p.book_id === bookId) || null;
}

export async function putBlob(packId, path, blob) {
  const stored = await blobToStored(blob);
  const { stores, t } = await tx([BLOBS], "readwrite");
  await reqToPromise(stores[BLOBS].put(stored, blobKey(packId, path)));
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getBlob(packId, path) {
  const { stores } = await tx([BLOBS], "readonly");
  const stored = await reqToPromise(stores[BLOBS].get(blobKey(packId, path)));
  return storedToBlob(stored);
}

export async function deletePack(packId) {
  const pack = await getInstalledPack(packId);
  if (!pack) return false;
  const paths = [
    ...(pack.blob_paths || []),
    BOOK_NAME, VOICES_NAME, MEDIA_INDEX_NAME, AUDIO_MANIFEST_NAME,
  ];
  const { stores, t } = await tx([PACKS, BLOBS], "readwrite");
  for (const p of paths) {
    stores[BLOBS].delete(blobKey(packId, p));
  }
  stores[PACKS].delete(packId);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

/** Persist manifest + JSON sidecars; binary assets stored separately via putBlob. */
export async function savePackRecord(record) {
  const { stores, t } = await tx([PACKS], "readwrite");
  stores[PACKS].put(record);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(record);
    t.onerror = () => reject(t.error);
  });
}

export async function installPackFromEntries(manifest, entries, { origin = "import" } = {}) {
  validateManifest(manifest);
  const packId = manifest.pack_id;
  const blobPaths = [];

  const readText = (name) => {
    const e = entries[name];
    if (!e) throw new Error(`missing ${name}`);
    return new TextDecoder().decode(e);
  };

  const book = JSON.parse(readText(BOOK_NAME));
  const voices = JSON.parse(readText(VOICES_NAME));
  const mediaIndex = JSON.parse(readText(MEDIA_INDEX_NAME));
  let audioManifest = [];
  if (entries[AUDIO_MANIFEST_NAME]) {
    audioManifest = JSON.parse(readText(AUDIO_MANIFEST_NAME));
  }

  for (const [, packPath] of Object.entries(mediaIndex)) {
    const data = entries[packPath];
    if (data) {
      blobPaths.push(packPath);
      await putBlob(packId, packPath, new Blob([data]));
    }
  }
  for (const item of audioManifest) {
    const data = entries[item.path];
    if (data) {
      blobPaths.push(item.path);
      await putBlob(packId, item.path, new Blob([data], { type: "audio/mpeg" }));
    }
  }

  const record = {
    pack_id: packId,
    book_id: manifest.book_id,
    title: manifest.title || book.title,
    author: manifest.author || book.author,
    tier: manifest.tier,
    style: manifest.style,
    audio_engine: manifest.audio_engine,
    manifest,
    book,
    voices,
    media_index: mediaIndex,
    audio_manifest: audioManifest,
    blob_paths: blobPaths,
    pack_origin: origin,
    installed_at: Date.now(),
    size_bytes: blobPaths.reduce((n, p) => n + (entries[p]?.byteLength || 0), 0),
  };
  await savePackRecord(record);
  return record;
}

export async function packSizeBytes(packId) {
  const pack = await getInstalledPack(packId);
  if (!pack) return 0;
  let total = 0;
  for (const p of pack.blob_paths || []) {
    const b = await getBlob(packId, p);
    if (b) total += b.size;
  }
  return total;
}

export function formatBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
