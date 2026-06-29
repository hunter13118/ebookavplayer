/** Desktop folder library via File System Access API (Chrome / Edge). */
import { getSetting, putSetting, deleteSetting } from "./packStore.js";
import { isPackArchiveName } from "./packIo.js";

const FOLDER_HANDLE_KEY = "linked-pack-folder";
const FOLDER_SCAN_KEY = "linked-pack-folder-scan";

export function supportsFolderLibrary() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export function fileFingerprint(file) {
  return `${file.size}:${file.lastModified}`;
}

async function folderPermission(handle, mode = "read") {
  if (!handle?.queryPermission) return "granted";
  let state = await handle.queryPermission({ mode });
  if (state === "granted") return state;
  if (handle.requestPermission) state = await handle.requestPermission({ mode });
  return state;
}

export async function getLinkedFolderInfo() {
  const stored = await getSetting(FOLDER_HANDLE_KEY);
  if (!stored?.handle) return null;
  return {
    name: stored.name || "Linked folder",
    linked_at: stored.linked_at || null,
  };
}

export async function getLinkedFolderHandle() {
  const stored = await getSetting(FOLDER_HANDLE_KEY);
  return stored?.handle || null;
}

export async function linkPackFolder() {
  const handle = await window.showDirectoryPicker({ mode: "read" });
  const entry = { handle, name: handle.name, linked_at: Date.now() };
  await putSetting(FOLDER_HANDLE_KEY, entry);
  await putSetting(FOLDER_SCAN_KEY, { files: {}, last_scan: null });
  return entry;
}

export async function unlinkPackFolder() {
  await deleteSetting(FOLDER_HANDLE_KEY);
  await deleteSetting(FOLDER_SCAN_KEY);
}

async function getScanMeta() {
  return (await getSetting(FOLDER_SCAN_KEY)) || { files: {}, last_scan: null };
}

async function saveScanMeta(meta) {
  await putSetting(FOLDER_SCAN_KEY, { ...meta, last_scan: Date.now() });
}

export async function listPackFilesInFolder(handle) {
  const out = [];
  for await (const entry of handle.values()) {
    if (entry.kind === "file" && isPackArchiveName(entry.name)) out.push(entry);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Scan linked folder and return File objects that are new or changed since last scan.
 * @param {{ force?: boolean }} opts
 */
export async function collectFolderPackFiles(opts = {}) {
  const handle = await getLinkedFolderHandle();
  if (!handle) return { handle: null, files: [], folderName: null };

  const perm = await folderPermission(handle);
  if (perm !== "granted") throw new Error("Folder access denied — link the folder again.");

  const meta = opts.force ? { files: {}, last_scan: null } : await getScanMeta();
  const entries = await listPackFilesInFolder(handle);
  const files = [];
  for (const entry of entries) {
    const file = await entry.getFile();
    const fp = fileFingerprint(file);
    if (opts.force || meta.files[file.name] !== fp) files.push(file);
  }
  return { handle, files, folderName: handle.name, meta };
}

/** Update scan fingerprints after successful imports. */
export async function markFolderFilesImported(files) {
  const meta = await getScanMeta();
  for (const file of files) {
    meta.files[file.name] = fileFingerprint(file);
  }
  await saveScanMeta(meta);
}

export async function scanLinkedFolderSummary() {
  const handle = await getLinkedFolderHandle();
  if (!handle) return null;
  const perm = await folderPermission(handle);
  if (perm !== "granted") return { name: handle.name, pack_count: 0, permission: perm };
  const entries = await listPackFilesInFolder(handle);
  const meta = await getScanMeta();
  let pending = 0;
  for (const entry of entries) {
    const file = await entry.getFile();
    if (meta.files[file.name] !== fileFingerprint(file)) pending += 1;
  }
  return {
    name: handle.name,
    pack_count: entries.length,
    pending,
    permission: perm,
    last_scan: meta.last_scan,
  };
}
