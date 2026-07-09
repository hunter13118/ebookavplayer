/** Chapter boundaries + character presence from compiled scenes. */

export function buildChapterIndex(scenes) {
  const byChapter = new Map();
  let lineIdx = 0;

  for (const scene of scenes || []) {
    const chapter = scene.chapter ?? 1;
    if (!byChapter.has(chapter)) {
      byChapter.set(chapter, {
        chapter,
        startLine: lineIdx,
        endLine: lineIdx - 1,
        characters: new Set(),
        sceneTitles: [],
      });
    }
    const entry = byChapter.get(chapter);
    if (scene.title && !entry.sceneTitles.includes(scene.title)) {
      entry.sceneTitles.push(scene.title);
    }
    for (const p of scene.present || []) {
      const cid = typeof p === "string" ? p : p?.character_id;
      if (cid && cid !== "narrator") entry.characters.add(cid);
    }
    const sceneLines = scene.lines || [];
    if (sceneLines.length && entry.endLine < entry.startLine) {
      entry.startLine = lineIdx;
    }
    for (const ln of sceneLines) {
      if (ln.character_id && ln.character_id !== "narrator") {
        entry.characters.add(ln.character_id);
      }
      entry.endLine = lineIdx;
      lineIdx += 1;
    }
  }

  return [...byChapter.values()]
    .filter((ch) => ch.endLine >= ch.startLine)
    .sort((a, b) => a.chapter - b.chapter);
}

export function chapterAtLine(chapters, lineIndex) {
  for (const ch of chapters) {
    if (lineIndex >= ch.startLine && lineIndex <= ch.endLine) return ch;
  }
  return chapters[0] || null;
}

export function chapterLineCount(ch) {
  if (!ch) return 0;
  return ch.endLine - ch.startLine + 1;
}

export function chapterRelativeIndex(chapters, lineIndex) {
  const ch = chapterAtLine(chapters, lineIndex);
  if (!ch) {
    return { chapter: null, relIndex: lineIndex, chapterTotal: 0, absIndex: lineIndex };
  }
  return {
    chapter: ch,
    relIndex: lineIndex - ch.startLine,
    chapterTotal: chapterLineCount(ch),
    absIndex: lineIndex,
  };
}

export function chapterLabel(ch, chapterMeta) {
  if (!ch) return "Chapter";
  // book.chapters entries (chapter-extract-pipeline.js) carry the chapter
  // number as `.index`, not `.chapter` — matching on `.chapter` here always
  // missed (every entry's `.chapter` is undefined), silently falling back
  // to the generic "Chapter N" label even when a real EPUB title exists.
  const meta = (chapterMeta || []).find((m) => m.index === ch.chapter);
  if (meta?.title) return `Ch. ${ch.chapter}: ${meta.title}`;
  return `Chapter ${ch.chapter}`;
}

export function charactersForChapter(chapters, chapterNum, allCharacters, { book } = {}) {
  const ch = chapters.find((c) => c.chapter === chapterNum);
  if (!ch) return [];
  const ids = ch.characters;
  const importance = (id) => book?.characters?.[id]?.importance || "secondary";
  const rank = { primary: 0, secondary: 1, background: 2 };
  return allCharacters
    .filter((c) => ids.has(c.id))
    .sort((a, b) => (rank[importance(a.id)] ?? 9) - (rank[importance(b.id)] ?? 9)
      || a.name.localeCompare(b.name));
}

export function sliceLinesForChapter(lines, ch) {
  if (!ch || !lines?.length) return [];
  return lines.slice(ch.startLine, ch.endLine + 1);
}
