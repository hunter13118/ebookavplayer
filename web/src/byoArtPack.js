/**
 * BYO art pack — zip or folder of named images → player slots.
 *
 * Filename convention (case-insensitive stem):
 *   cover.png
 *   char_{character_id}.png     e.g. char_mei-asano.png
 *   bg_{scene_id}.png           e.g. bg_scene-0001.png
 *   insert_{line_index}.png     0-based line idx, e.g. insert_27.png
 *   moment_{line_index}.png     alias for insert
 *
 * Character ids also match slugified display names (mei-asano ↔ "Mei Asano").
 */
import { unzipSync } from "fflate";
import { listArtMediaItems } from "./artMediaItems.js";

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export function slugifyName(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function suggestedArtFilename(item) {
  if (!item) return null;
  if (item.kind === "cover") return "cover.png";
  if (item.kind === "characters") return `char_${item.id}.png`;
  if (item.kind === "backgrounds") return `bg_${item.id}.png`;
  if (item.kind === "inserts") return `insert_${item.id}.png`;
  return null;
}

function mimeFromPath(path) {
  const lower = String(path).toLowerCase();
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "image/png";
}

function basename(path) {
  return String(path || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

function isJunkPath(path) {
  const p = String(path).replace(/\\/g, "/");
  return p.includes("__MACOSX") || p.endsWith(".DS_Store") || p.split("/").some((s) => s.startsWith("."));
}

function buildCharacterLookup(book) {
  const byId = {};
  const bySlug = {};
  for (const [id, c] of Object.entries(book?.characters || {})) {
    if (id === "narrator") continue;
    byId[id] = id;
    byId[id.toLowerCase()] = id;
    const slug = slugifyName(c?.name || id);
    if (slug) bySlug[slug] = id;
    bySlug[slugifyName(id)] = id;
  }
  return { byId, bySlug };
}

function buildSceneLookup(book) {
  const byId = {};
  for (const s of book?.scenes || []) {
    if (!s?.id) continue;
    byId[s.id] = s.id;
    byId[s.id.toLowerCase()] = s.id;
    byId[slugifyName(s.id)] = s.id;
  }
  return byId;
}

function resolveCharacterId(token, book) {
  const { byId, bySlug } = buildCharacterLookup(book);
  const t = String(token || "").trim();
  const lower = t.toLowerCase();
  if (byId[t] || byId[lower]) return byId[t] || byId[lower];
  const slug = slugifyName(t);
  return bySlug[slug] || null;
}

function resolveSceneId(token, book) {
  const byId = buildSceneLookup(book);
  const t = String(token || "").trim();
  const lower = t.toLowerCase();
  if (byId[t] || byId[lower]) return byId[t] || byId[lower];
  return bySlugScene(token, book);
}

function bySlugScene(token, book) {
  const slug = slugifyName(token);
  for (const s of book?.scenes || []) {
    if (slugifyName(s.id) === slug) return s.id;
  }
  return null;
}

function lineExists(book, lineIdx) {
  const n = parseInt(lineIdx, 10);
  if (Number.isNaN(n)) return false;
  for (const scene of book?.scenes || []) {
    for (const line of scene.lines || []) {
      if (line.idx === n) return true;
    }
  }
  return false;
}

/** Map a zip/folder entry path → slot descriptor or null. */
export function matchArtPackFilename(path, book) {
  const name = basename(path);
  if (!IMAGE_EXT.test(name) || isJunkPath(path)) return null;

  const stem = name.replace(IMAGE_EXT, "").toLowerCase();

  if (stem === "cover") {
    return { kind: "cover", key: "cover", label: "Cover" };
  }

  let m = stem.match(/^char[_-](.+)$/);
  if (m) {
    const id = resolveCharacterId(m[1], book);
    if (!id) return null;
    const label = book.characters?.[id]?.name || id;
    return { kind: "characters", key: id, label };
  }

  m = stem.match(/^bg[_-](.+)$/);
  if (m) {
    const id = resolveSceneId(m[1], book);
    if (!id) return null;
    const scene = (book.scenes || []).find((s) => s.id === id);
    return { kind: "backgrounds", key: id, label: scene?.title || id };
  }

  m = stem.match(/^(?:insert|moment)[_-](\d+)$/);
  if (m) {
    if (!lineExists(book, m[1])) return null;
    const idx = parseInt(m[1], 10);
    return { kind: "inserts", key: String(idx), label: `Moment · slide ${idx + 1}` };
  }

  return null;
}

/** @returns {Promise<Array<{ path: string, file: File }>>} */
export async function readArtPackFromZip(file) {
  const buf = await file.arrayBuffer();
  const entries = unzipSync(new Uint8Array(buf));
  const out = [];
  for (const [path, data] of Object.entries(entries)) {
    if (!data?.length || path.endsWith("/") || isJunkPath(path)) continue;
    if (!IMAGE_EXT.test(basename(path))) continue;
    const name = basename(path);
    out.push({
      path,
      file: new File([data], name, { type: mimeFromPath(path) }),
    });
  }
  return out;
}

/** @returns {Array<{ path: string, file: File }>} */
export function readArtPackFromFileList(fileList) {
  const out = [];
  for (const file of fileList || []) {
    if (!file?.name || !IMAGE_EXT.test(file.name)) continue;
    if (isJunkPath(file.webkitRelativePath || file.name)) continue;
    out.push({
      path: file.webkitRelativePath || file.name,
      file,
    });
  }
  return out;
}

/** @returns {Promise<Array<{ path: string, file: File }>>} */
export async function readArtPackInput(input) {
  if (!input) return [];
  if (input instanceof File) {
    if (/\.zip$/i.test(input.name)) return readArtPackFromZip(input);
    if (IMAGE_EXT.test(input.name)) return [{ path: input.name, file: input }];
    throw new Error("Expected a .zip art pack or an image file.");
  }
  if (typeof input.length === "number") return readArtPackFromFileList(input);
  throw new Error("Unsupported art pack input.");
}

/** Plan uploads: matched slots + unrecognized files. */
export function planArtPackUpload(book, entries) {
  const matched = [];
  const unmatched = [];
  const used = new Set();

  for (const entry of entries || []) {
    const slot = matchArtPackFilename(entry.path || entry.file?.name, book);
    if (!slot) {
      unmatched.push({
        path: entry.path || entry.file?.name,
        reason: "Name not recognized — use cover.png, char_{id}.png, bg_{scene}.png, insert_{n}.png",
      });
      continue;
    }
    const dedupe = `${slot.kind}:${slot.key}`;
    if (used.has(dedupe)) {
      unmatched.push({
        path: entry.path || entry.file?.name,
        reason: `Duplicate slot (${slot.label})`,
      });
      continue;
    }
    used.add(dedupe);
    matched.push({ ...slot, path: entry.path, file: entry.file });
  }

  return { matched, unmatched };
}

export function buildArtPackManifest(book) {
  const items = listArtMediaItems(book);
  return {
    format: "ebookavplayer-byo-art-pack-v1",
    book_id: book?.book_id,
    title: book?.title,
    naming: {
      cover: "cover.png",
      character: "char_{character_id}.png",
      background: "bg_{scene_id}.png",
      moment: "insert_{line_index}.png (0-based line index)",
    },
    files: items.map((it) => ({
      filename: suggestedArtFilename(it),
      slot: it.key,
      kind: it.kind,
      label: it.label,
    })),
  };
}

export function downloadArtPackManifest(book) {
  const payload = buildArtPackManifest(book);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${book?.book_id || "book"}-art-pack-manifest.json`;
  a.click();
  URL.revokeObjectURL(url);
}
