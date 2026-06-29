/** Unified book access: local offline pack first, then server API. */
import { fetchBook as fetchBookRemote, fetchCatalog as fetchCatalogRemote, apiUrl } from "../api.js";
import {
  listInstalledPacks, getInstalledPackForBook, packSizeBytes, formatBytes, deletePack,
} from "./packStore.js";
import { importPackZip, readFileAsArrayBuffer, isPackArchiveName, downloadInstalledPack, saveBlobAsFile } from "./packIo.js";
import { getInstalledPack } from "./packStore.js";
import {
  linkPackFolder, unlinkPackFolder, supportsFolderLibrary, collectFolderPackFiles,
  markFolderFilesImported, scanLinkedFolderSummary, getLinkedFolderInfo,
} from "./packFolder.js";
import { activatePackForBook, packSupportsOfflineAudio, warmOfflineMedia } from "./packBridge.js";
import { TIER_AUDIOBOOK, TIER_VISUAL, packFilename } from "./packFormat.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function startPackBuild(bookId, { tier = TIER_AUDIOBOOK, style, force = false } = {}) {
  const body = { tier, force };
  if (style) body.style = style;
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/pack/build`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`pack build: HTTP ${res.status}`);
  return res.json();
}

export async function pollPackBuild(bookId, jobId) {
  const res = await fetch(apiUrl(
    `/books/${encodeURIComponent(bookId)}/pack/build/${encodeURIComponent(jobId)}`,
  ));
  if (!res.ok) throw new Error(`pack status: HTTP ${res.status}`);
  return res.json();
}

export async function cancelPackBuild(bookId, jobId) {
  const res = await fetch(apiUrl(
    `/books/${encodeURIComponent(bookId)}/pack/build/${encodeURIComponent(jobId)}/cancel`,
  ), { method: "POST" });
  if (!res.ok) throw new Error(`pack cancel: HTTP ${res.status}`);
  return res.json();
}

export async function fetchExternalAudioManifest(bookId) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/audio/manifest`));
  if (!res.ok) throw new Error(`audio manifest: HTTP ${res.status}`);
  return res.json();
}

export async function importExternalAudioFile(bookId, file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/audio/import`), {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw new Error(`audio import: HTTP ${res.status}`);
  return res.json();
}

export async function deleteExternalAudio(bookId) {
  const res = await fetch(apiUrl(`/books/${encodeURIComponent(bookId)}/audio`), {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`audio delete: HTTP ${res.status}`);
  return res.json();
}

export async function downloadPackBuildFile(bookId, jobId) {
  const res = await fetch(apiUrl(
    `/books/${encodeURIComponent(bookId)}/pack/build/${encodeURIComponent(jobId)}/file`,
  ));
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || "Pack still building — wait for progress to reach 100%.");
  }
  if (!res.ok) throw new Error(`pack file: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** Derive catalog cover from packed book JSON or media index. */
export function coverFromPackRecord(pack) {
  const book = pack?.book || {};
  if (book.cover) return String(book.cover).split("?")[0];
  for (const serverUrl of Object.keys(pack?.media_index || {})) {
    const base = String(serverUrl).split("?")[0];
    if (/\/cover\.(png|jpe?g|webp)$/i.test(base)) return base;
  }
  return null;
}

function catalogFromPack(pack) {
  const book = pack.book || {};
  const lines = (book.scenes || []).reduce((n, s) => n + (s.lines?.length || 0), 0);
  return {
    book_id: pack.book_id,
    title: pack.title || book.title || pack.book_id,
    author: pack.author || book.author || "",
    status: "ready",
    stage: "done",
    progress: 1,
    cover: coverFromPackRecord(pack),
    scenes: (book.scenes || []).length,
    lines,
    offline_pack: true,
    pack_id: pack.pack_id,
    pack_tier: pack.tier,
    pack_style: pack.style,
    pack_origin: pack.pack_origin || "import",
    offline_audio: packSupportsOfflineAudio(pack),
  };
}

export async function fetchLocalCatalog() {
  const packs = await listInstalledPacks();
  return Promise.all(packs.map(async (p) => {
    const entry = catalogFromPack(p);
    try {
      entry.pack_size = formatBytes(await packSizeBytes(p.pack_id));
    } catch { entry.pack_size = ""; }
    return entry;
  }));
}

export async function mergeCatalog(serverList) {
  const local = await fetchLocalCatalog();
  const byId = new Map();
  for (const e of serverList || []) byId.set(e.book_id, { ...e, offline_pack: false });
  for (const e of local) {
    const prev = byId.get(e.book_id);
    if (prev) {
      const merged = { ...prev, ...e, offline_pack: true, server_available: true };
      if (!e.cover && prev.cover) merged.cover = prev.cover;
      if (!e.title && prev.title) merged.title = prev.title;
      if (!e.author && prev.author) merged.author = prev.author;
      byId.set(e.book_id, merged);
    } else {
      byId.set(e.book_id, { ...e, server_available: false });
    }
  }
  return [...byId.values()].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
}

function bookFromLocalPack(local) {
  const out = { ...local.book };
  out.voice_overrides = local.voices || out.voice_overrides || {};
  out.offline_pack = {
    pack_id: local.pack_id,
    tier: local.tier,
    style: local.style,
    audio: packSupportsOfflineAudio(local),
  };
  out.status = "ready";
  out.stage = "done";
  out.progress = 1;
  return out;
}

export async function fetchBook(bookId, opts = {}) {
  const local = await getInstalledPackForBook(bookId);
  const preferLocal = Boolean(opts.preferLocal);

  if (preferLocal && local?.book) {
    await activatePackForBook(bookId);
    await warmOfflineMedia(local);
    return bookFromLocalPack(local);
  }

  try {
    const remote = await fetchBookRemote(bookId, opts);
    if (local?.book) {
      await activatePackForBook(bookId);
      await warmOfflineMedia(local);
      return {
        ...remote,
        voice_overrides: remote.voice_overrides || local.voices || {},
        offline_pack: {
          pack_id: local.pack_id,
          tier: local.tier,
          style: local.style,
          audio: packSupportsOfflineAudio(local),
        },
      };
    }
    return remote;
  } catch (e) {
    if (local?.book) {
      await activatePackForBook(bookId);
      await warmOfflineMedia(local);
      return bookFromLocalPack(local);
    }
    throw e;
  }
}

export async function fetchCatalogMerged() {
  try {
    const server = await fetchCatalogRemote();
    return mergeCatalog(server);
  } catch {
    return fetchLocalCatalog();
  }
}

export async function importOfflinePackFile(file) {
  const results = await importOfflinePackFiles([file]);
  if (results.failed.length) throw new Error(results.failed[0].error);
  if (!results.imported.length) throw new Error("no pack imported");
  return results.imported[0];
}

export async function importOfflinePackFiles(files, { onProgress } = {}) {
  const list = [...(files || [])].filter(Boolean);
  const imported = [];
  const failed = [];
  const skipped = [];
  let step = 0;
  for (const file of list) {
    if (!isPackArchiveName(file.name)) {
      skipped.push(file.name);
      continue;
    }
    try {
      const buf = await readFileAsArrayBuffer(file);
      const record = await importPackZip(buf, { origin: "import" });
      await activatePackForBook(record.book_id);
      imported.push(record);
    } catch (e) {
      failed.push({ name: file.name, error: e.message || "import failed" });
    }
    step += 1;
    onProgress?.(step, list.length, file.name);
  }
  return { imported, failed, skipped };
}

export async function exportInstalledPack(packId) {
  const record = await getInstalledPack(packId);
  if (!record) throw new Error("pack not installed");
  await downloadInstalledPack(record);
  return record;
}

export async function scanLinkedPackFolder({ force = false, onProgress } = {}) {
  const { files, folderName } = await collectFolderPackFiles({ force });
  if (!folderName) {
    return { imported: [], failed: [], skipped: [], folderName: null, message: "No folder linked." };
  }
  if (!files.length) {
    return { imported: [], failed: [], skipped: [], folderName, message: "Folder up to date." };
  }
  const imported = [];
  const failed = [];
  const skipped = [];
  const databaseFiles = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!isPackArchiveName(file.name)) {
      skipped.push(file.name);
      continue;
    }
    try {
      const buf = await readFileAsArrayBuffer(file);
      const record = await importPackZip(buf, { origin: "folder" });
      await activatePackForBook(record.book_id);
      imported.push(record);
      databaseFiles.push(file);
    } catch (e) {
      failed.push({ name: file.name, error: e.message || "import failed" });
    }
    onProgress?.(i + 1, files.length, file.name);
  }
  if (databaseFiles.length) await markFolderFilesImported(databaseFiles);
  return { imported, failed, skipped, folderName };
}

export {
  linkPackFolder, unlinkPackFolder, supportsFolderLibrary,
  scanLinkedFolderSummary, getLinkedFolderInfo,
};

export async function fetchServerPackZip(bookId, {
  tier = TIER_VISUAL, style, force = false, onProgress,
} = {}) {
  const started = await startPackBuild(bookId, { tier, style, force });
  const jobId = started.job_id;
  if (!jobId) throw new Error("pack build: no job id");
  if (!started.cached) {
    for (;;) {
      const st = await pollPackBuild(bookId, jobId);
      onProgress?.(st.progress ?? 0, st.detail || "", st);
      if (st.status === "done" || st.ready) break;
      if (st.status === "cancelled") throw new Error("pack build cancelled");
      if (st.status === "error") {
        throw new Error(st.error || st.detail || "pack build failed");
      }
      await sleep(1200);
    }
  }
  return downloadPackBuildFile(bookId, jobId);
}

export async function pickPackSaveHandle(bookId) {
  if (typeof window === "undefined" || typeof window.showSaveFilePicker !== "function") {
    return null;
  }
  const pack = await getInstalledPackForBook(bookId);
  const suggested = pack ? packFilename(pack.manifest) : `${bookId}.visual.vaepack`;
  return window.showSaveFilePicker({
    suggestedName: suggested,
    types: [{
      description: "Visual Audiobook Pack",
      accept: { "application/zip": [".vaepack", ".zip"] },
    }],
  });
}

export async function downloadOfflinePack(bookId, {
  tier = TIER_VISUAL, style, force = false, onProgress, onJobStarted,
} = {}) {
  const started = await startPackBuild(bookId, { tier, style, force });
  const jobId = started.job_id;
  if (!jobId) throw new Error("pack build: no job id");
  onJobStarted?.(jobId, started);
  if (started.cached) onProgress?.(1, "cache hit");
  else {
    for (;;) {
      const st = await pollPackBuild(bookId, jobId);
      onProgress?.(st.progress ?? 0, st.detail || "", st);
      if (st.status === "done" || st.ready) break;
      if (st.status === "cancelled") throw new Error("pack build cancelled");
      if (st.status === "error") {
        throw new Error(st.error || st.detail || "pack build failed");
      }
      await sleep(1200);
    }
  }
  const buf = await downloadPackBuildFile(bookId, jobId);
  return importPackZip(buf, { origin: "server" });
}

/** Silently cache a server book into browser storage (visual tier). */
export async function ensureBookCached(bookId, opts = {}) {
  const existing = await getInstalledPackForBook(bookId);
  if (existing) return existing;
  return downloadOfflinePack(bookId, { tier: TIER_VISUAL, ...opts });
}

/** Download .vaepack file — prefer fresh server zip, fall back to local IndexedDB rebuild. */
export async function exportBookPackFile(bookId, { saveHandle = null, onProgress } = {}) {
  const pack = await getInstalledPackForBook(bookId);
  const name = pack ? packFilename(pack.manifest) : `${bookId}.visual.vaepack`;
  let serverErr = null;

  try {
    const buf = await fetchServerPackZip(bookId, { tier: TIER_VISUAL, onProgress });
    await saveBlobAsFile(new Blob([buf], { type: "application/zip" }), name, { saveHandle });
    return pack || { book_id: bookId };
  } catch (e) {
    serverErr = e;
  }

  if (!pack) {
    throw serverErr || new Error("Book is not cached on this device yet");
  }
  await downloadInstalledPack(pack, { saveHandle });
  return pack;
}

/** Remove local pack only (cloud copy unchanged). */
export async function removeLocalPack(bookId) {
  const pack = await getInstalledPackForBook(bookId);
  if (!pack) return false;
  return deletePack(pack.pack_id);
}

export { TIER_VISUAL, TIER_AUDIOBOOK };
