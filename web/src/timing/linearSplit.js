// ALGORITHM 1 — Linear Character Split ("Dumb Online").
//
// Strategy: a purely naive, symmetrical distribution. Within each chapter, take the
// chapter's audio duration and split it across slides in direct proportion to each
// slide's raw character count. No grammar awareness, no acoustics — just chars.
//
// The zero-drift guarantee (sum of slide durations === chapter duration, exactly)
// comes entirely from distribute.js's cumulative-boundary rounding.
//
// Output is tagged `marker: 'naive-linear-fallback'` so the UI/telemetry can show
// that this is the crude baseline, suitable as a universal fallback.

import { spanSlides } from "./distribute.js";
import { resolveChapterSpans, buildResult } from "./slides.js";

export const LINEAR_MARKER = "naive-linear-fallback";

/**
 * @param {Object} input
 * @param {import('./types.js').ChapterSlides[]} input.slidesByChapter
 * @param {number[]|Record<number,number>} input.chapterDurationsMs
 *        Per-chapter audio duration (ms). Array aligned to slidesByChapter, or a map
 *        keyed by chapter number. For a chapter-less audiobook, pass a single-entry
 *        structure treating the whole book as one chapter.
 * @returns {import('./types.js').TimingResult}
 */
export function linearSplit({ slidesByChapter, chapterDurationsMs }) {
  const spans = resolveChapterSpans(slidesByChapter, chapterDurationsMs);

  /** @type {import('./types.js').ChapterTiming[]} */
  const chapters = slidesByChapter.map((ch, i) => {
    const { baseMs, durationMs } = spans[i];
    const slides = spanSlides(baseMs, durationMs, ch.slides, (s) => s.charCount);
    return {
      chapter: ch.chapter,
      startMs: baseMs,
      endMs: baseMs + durationMs,
      durationMs,
      slides,
    };
  });

  return buildResult("linear", LINEAR_MARKER, chapters, { strategy: "linear-char" });
}
