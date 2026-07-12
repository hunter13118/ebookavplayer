/** Build selectable art targets from a compiled playback book. */
import { buildChapterIndex, chapterLabel } from "./chapterNav.js";
import { sceneDisplayTitle } from "./sceneLabels.js";

export function listArtMediaItems(book) {
  const items = [];
  if (!book) return items;

  items.push({
    key: "cover",
    kind: "cover",
    id: "cover",
    label: "Cover",
    preview: book.cover || null,
    chapter: 0,
  });

  Object.entries(book.characters || {})
    .filter(([id]) => id !== "narrator")
    .forEach(([id, c]) => {
      items.push({
        key: `char:${id}`,
        kind: "characters",
        id,
        label: c.name || id,
        preview: c.sprite || null,
        importance: c.importance || "secondary",
        // Chapter the character was first introduced in (stamped by
        // compileChapterPlayback). Legacy books compiled before that existed
        // won't have this — they all fall back to chapter 0, grouped together.
        chapter: c.chapter ?? 0,
      });
    });

  (book.scenes || []).forEach((s) => {
    items.push({
      key: `bg:${s.id}`,
      kind: "backgrounds",
      id: s.id,
      label: sceneDisplayTitle(s),
      preview: s.background || null,
      chapter: s.chapter ?? 1,
      sceneId: s.id,
    });
  });

  const inserts = book.inserts || {};
  const lineByIdx = new Map();
  (book.scenes || []).forEach((s) => {
    (s.lines || []).forEach((ln) => {
      lineByIdx.set(ln.idx, { line: ln, scene: s });
    });
  });
  Object.entries(inserts).forEach(([idx, url]) => {
    const n = parseInt(idx, 10);
    const hit = lineByIdx.get(n);
    const line = hit?.line;
    const scene = hit?.scene;
    items.push({
      key: `insert:${idx}`,
      kind: "inserts",
      id: idx,
      label: line
        ? `Moment · slide ${n + 1}${line.speaker_name ? ` · ${line.speaker_name}` : ""}`
        : `Moment · slide ${n + 1}`,
      preview: url || null,
      sceneTitle: scene ? sceneDisplayTitle(scene) : "",
      chapter: scene?.chapter ?? 1,
      sceneId: scene?.id,
    });
  });

  return items;
}

const IMPORTANCE_RANK = { primary: 0, secondary: 1, background: 2 };

function sortByImportanceThenLabel(a, b) {
  return (IMPORTANCE_RANK[a.importance] ?? 9) - (IMPORTANCE_RANK[b.importance] ?? 9)
    || a.label.localeCompare(b.label);
}

/**
 * Group art items for long books: cover, then characters/backgrounds/inserts
 * together by the chapter they belong to — characters are grouped by the
 * chapter they were first introduced in, same treatment backgrounds already
 * got, instead of one flat "Characters" list spanning the whole book.
 */
export function listArtMediaGroups(book) {
  const items = listArtMediaItems(book);
  const chapters = buildChapterIndex(book?.scenes);
  const chapterMeta = book?.chapters || [];
  const groups = [];

  const cover = items.filter((it) => it.kind === "cover");
  if (cover.length) groups.push({ id: "cover", label: "Cover", items: cover });

  // Characters may reference a chapter (0-based position) that has no scene
  // of its own in buildChapterIndex — union both sources of chapter numbers
  // so nobody silently drops into "Other" just because their chapter has
  // zero backgrounds.
  const chapterNums = new Set(chapters.map((ch) => ch.chapter));
  for (const it of items) {
    if (it.kind === "characters") chapterNums.add(it.chapter ?? 0);
  }

  for (const chapterNum of [...chapterNums].sort((a, b) => a - b)) {
    const ch = chapters.find((c) => c.chapter === chapterNum) || { chapter: chapterNum };
    const chChars = items
      .filter((it) => it.kind === "characters" && it.chapter === chapterNum)
      .sort(sortByImportanceThenLabel);
    const chOther = items.filter((it) =>
      (it.kind === "backgrounds" || it.kind === "inserts") && it.chapter === chapterNum);
    const chItems = [...chChars, ...chOther];
    if (!chItems.length) continue;
    groups.push({
      id: `chapter-${chapterNum}`,
      label: chapterLabel(ch, chapterMeta),
      items: chItems,
    });
  }

  const groupedKeys = new Set(groups.flatMap((g) => g.items.map((it) => it.key)));
  const orphans = items.filter((it) => !groupedKeys.has(it.key));
  if (orphans.length) {
    groups.push({ id: "other", label: "Other", items: orphans });
  }

  return groups;
}

/** Active art style for replace-media (respects pixel filter source). */
export function resolveReplaceArtStyle(book) {
  const active = book?.active_style || book?.art_style || "anime";
  if (active === "pixel" && book?.art_filter === "pixel") {
    const pixel = (book?.styles || []).find((s) => s.id === "pixel");
    if (pixel?.filter_source) return pixel.filter_source;
  }
  return active;
}

/** Map UI selection keys → generate-media request body. `styleOverride` (from
 * the art-style picker) takes precedence over the book's stored style.
 * `forceReference` is the manual override for local_sd's broken-grid
 * reference-rejection guard — see ReplaceArtSheet.jsx's checkbox. */
export function selectionToGenerateBody(selectedKeys, items, book, { styleOverride, forceReference } = {}) {
  const keys = new Set(selectedKeys);
  const picked = items.filter((it) => keys.has(it.key));
  if (!picked.length) throw new Error("Select at least one image to replace.");

  const artStyle = styleOverride || (book ? resolveReplaceArtStyle(book) : undefined);
  const base = artStyle ? { art_style: artStyle } : {};

  const all = picked.length === items.length;
  if (all) return { scope: "all", force_all: true, diversify: true, compare: true, ...base };

  const includeCover = picked.some((it) => it.kind === "cover");
  const characterIds = picked.filter((it) => it.kind === "characters").map((it) => it.id);
  const sceneIds = picked.filter((it) => it.kind === "backgrounds").map((it) => it.id);
  const insertLineIndices = picked
    .filter((it) => it.kind === "inserts")
    .map((it) => parseInt(it.id, 10))
    .filter((n) => !Number.isNaN(n));

  if (picked.every((it) => it.kind === "inserts") && insertLineIndices.length) {
    return {
      scope: "inserts",
      force_all: false,
      insert_line_indices: insertLineIndices,
      ignore_pins: true,
      compare: true,
      diversify: true,
      ...base,
    };
  }

  return {
    scope: "selected",
    force_all: false,
    include_cover: includeCover,
    character_ids: characterIds.length ? characterIds : null,
    scene_ids: sceneIds.length ? sceneIds : null,
    insert_line_indices: insertLineIndices.length ? insertLineIndices : null,
    ignore_pins: true,
    compare: true,
    diversify: true,
    force_reference: Boolean(forceReference && characterIds.length),
    ...base,
  };
}
