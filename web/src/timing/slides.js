// Slide model: flatten a book into chapter-grouped slides (lines), preserving the
// SAME global zero-based line index the orchestrator/resume/seek use. Plus the
// helper that assembles a unified TimingResult from per-chapter timings.

/**
 * Flatten book.scenes into chapter-grouped slides in reading order.
 * Mirrors Player.flatten()/chapterNav grouping but stays pure (no React, no DOM).
 *
 * @param {{ scenes?: Array<{chapter?:number, lines?:Array<{text?:string}>}> }} book
 * @returns {import('./types.js').ChapterSlides[]}
 */
export function buildSlidesByChapter(book) {
  /** @type {Map<number, import('./types.js').Slide[]>} */
  const byChapter = new Map();
  const order = [];
  let lineIndex = 0;
  for (const scene of book?.scenes || []) {
    const chapter = Number.isFinite(scene?.chapter) ? scene.chapter : 0;
    for (const line of scene?.lines || []) {
      const text = typeof line?.text === "string" ? line.text : "";
      if (!byChapter.has(chapter)) {
        byChapter.set(chapter, []);
        order.push(chapter);
      }
      byChapter.get(chapter).push({ lineIndex, chapter, text, charCount: text.length });
      lineIndex += 1;
    }
  }
  return order.map((chapter) => ({ chapter, slides: byChapter.get(chapter) }));
}

/** Total number of slides (lines) across all chapters. */
export function countSlides(slidesByChapter) {
  return slidesByChapter.reduce((n, c) => n + c.slides.length, 0);
}

/**
 * Assemble a unified TimingResult from already-computed per-chapter timings.
 * Builds the flat `lineTimings` lookup the orchestrator reads.
 *
 * @param {string} algorithm
 * @param {string} marker
 * @param {import('./types.js').ChapterTiming[]} chapters
 * @param {Object} [meta]
 * @param {Array<{id:string,startMs:number,endMs:number,text:string}>} [syntheticSegments]
 *        Audio-only content with no book-line counterpart (WhisperX gap
 *        detection) — narrator-filler entries the orchestrator merges into
 *        the playback timeline alongside `lineTimings`, keyed by timestamp
 *        rather than line index. Empty for every algorithm except whisperx.
 * @returns {import('./types.js').TimingResult}
 */
export function buildResult(algorithm, marker, chapters, meta = {}, syntheticSegments = []) {
  /** @type {Record<number,{startMs:number,endMs:number,durationMs:number}>} */
  const lineTimings = {};
  let totalDurationMs = 0;
  for (const ch of chapters) {
    totalDurationMs = Math.max(totalDurationMs, ch.endMs);
    for (const s of ch.slides) {
      lineTimings[s.lineIndex] = {
        startMs: s.startMs,
        endMs: s.endMs,
        durationMs: s.durationMs,
      };
    }
  }
  return {
    algorithm, marker, unit: "line", totalDurationMs, chapters, lineTimings, meta, syntheticSegments,
  };
}

/**
 * Resolve a per-chapter duration source into [startMs, durationMs] for each chapter,
 * assuming chapters are contiguous and play back-to-back from the start of the book.
 *
 * `chapterDurationsMs` may be:
 *   - an array aligned to slidesByChapter order, OR
 *   - a map { [chapterNumber]: durationMs }.
 *
 * @param {import('./types.js').ChapterSlides[]} slidesByChapter
 * @param {number[]|Record<number,number>} chapterDurationsMs
 * @returns {{ chapter:number, baseMs:number, durationMs:number }[]}
 * @throws {Error} if a chapter has no resolvable duration.
 */
export function resolveChapterSpans(slidesByChapter, chapterDurationsMs) {
  const isArray = Array.isArray(chapterDurationsMs);
  const spans = [];
  let baseMs = 0;
  slidesByChapter.forEach((ch, i) => {
    const dur = isArray ? chapterDurationsMs[i] : chapterDurationsMs?.[ch.chapter];
    if (!Number.isFinite(dur) || dur < 0) {
      throw new Error(`resolveChapterSpans: missing/invalid duration for chapter ${ch.chapter} (index ${i})`);
    }
    spans.push({ chapter: ch.chapter, baseMs, durationMs: Math.round(dur) });
    baseMs += Math.round(dur);
  });
  return spans;
}
