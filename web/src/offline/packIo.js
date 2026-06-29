/** Import/export vae-offline-pack ZIP archives in the browser. */
import { unzipSync, zipSync } from "fflate";
import { MANIFEST_NAME, validateManifest, packFilename } from "./packFormat.js";
import { installPackFromEntries, getBlob } from "./packStore.js";
import { getResume, saveResume } from "../library.js";

const PACK_EXT = /\.(vaepack|zip)$/i;

export function isPackArchiveName(name) {
  return PACK_EXT.test(name || "");
}

function entriesFromZip(bytes) {
  const raw = unzipSync(new Uint8Array(bytes));
  const out = {};
  for (const [path, data] of Object.entries(raw)) {
    out[path] = data;
  }
  return out;
}

export async function importPackZip(bytes, { origin = "import" } = {}) {
  const entries = entriesFromZip(bytes);
  if (!entries[MANIFEST_NAME]) throw new Error("missing vae/manifest.json");
  const manifest = validateManifest(JSON.parse(new TextDecoder().decode(entries[MANIFEST_NAME])));
  const record = await installPackFromEntries(manifest, entries, { origin });
  const resume = record.book?.resume;
  if (resume && record.book_id) {
    saveResume(record.book_id, {
      line: resume.line ?? 0,
      sceneId: resume.sceneId || resume.scene_id || "",
      chapter: resume.chapter ?? 0,
      total: resume.total,
      completed: resume.completed,
    });
  }
  return record;
}

function collectBlobPaths(record) {
  const paths = new Set(record.blob_paths || []);
  for (const p of Object.values(record.media_index || {})) paths.add(p);
  for (const item of record.audio_manifest || []) {
    if (item.path) paths.add(item.path);
  }
  return paths;
}

/** Rebuild a full .vaepack zip including media/audio blobs from IndexedDB. */
export async function buildPackZipBytes(record) {
  if (!record?.manifest || !record?.book) throw new Error("invalid pack record");
  const bookId = record.book_id || record.book?.book_id;
  const book = { ...record.book };
  const localResume = bookId ? getResume(bookId) : null;
  if (localResume) {
    book.resume = { ...book.resume, ...localResume };
  }
  const files = {};
  const enc = new TextEncoder();
  files[MANIFEST_NAME] = enc.encode(JSON.stringify(record.manifest, null, 2));
  files["vae/book.json"] = enc.encode(JSON.stringify(book, null, 2));
  files["vae/voices.json"] = enc.encode(JSON.stringify(record.voices || {}, null, 2));
  files["vae/media/index.json"] = enc.encode(JSON.stringify(record.media_index || {}, null, 2));
  if (record.audio_manifest?.length) {
    files["vae/audio/manifest.json"] = enc.encode(JSON.stringify(record.audio_manifest, null, 2));
  }
  for (const path of collectBlobPaths(record)) {
    const blob = await getBlob(record.pack_id, path);
    if (blob) files[path] = new Uint8Array(await blob.arrayBuffer());
  }
  return zipSync(files, { level: 6 });
}

export async function downloadInstalledPack(record, { saveHandle = null } = {}) {
  const bytes = await buildPackZipBytes(record);
  const name = packDownloadName(record.manifest);
  await saveBlobAsFile(new Blob([bytes], { type: "application/zip" }), name, { saveHandle });
}

/** Persist a blob as a user-visible file download (desktop, iOS Share, or save picker). */
export async function saveBlobAsFile(blob, filename, { saveHandle = null } = {}) {
  if (saveHandle) {
    const w = await saveHandle.createWritable();
    await w.write(blob);
    await w.close();
    return "file-handle";
  }

  if (typeof navigator !== "undefined" && navigator.share && navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: blob.type || "application/zip" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return "share";
      }
    } catch (e) {
      if (e?.name === "AbortError") throw e;
    }
  }

  downloadBlob(filename, blob);
  return "anchor";
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function readFileAsArrayBuffer(file) {
  return file.arrayBuffer();
}

export function packDownloadName(manifest) {
  return packFilename(manifest);
}
