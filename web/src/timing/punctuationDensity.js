// ALGORITHM 2 — Punctuation-Anchor Density Map ("Smarter Online").
//
// Strategy: text length alone mis-paces narration because human readers PAUSE at
// punctuation, and pause length is fairly invariant across accents/dialects (a full
// stop is a beat no matter the reader's words-per-minute). So instead of distributing
// chapter duration by raw character count, we distribute by a STRUCTURAL WEIGHT:
//
//     weight(slide) = charCount * charWeight
//                   + Σ (bonus for each punctuation marker present)
//
// The punctuation bonuses act like extra "virtual characters" of time, padding the
// slides that contain heavier grammatical pauses. Weights are elastic/adjustable via
// the `weights` option so the engine can be tuned without code changes.
//
// Zero-drift is inherited from distribute.js exactly as in Algorithm 1.

import { spanSlides } from "./distribute.js";
import { resolveChapterSpans, buildResult } from "./slides.js";

export const PUNCTUATION_MARKER = "punctuation-density-map";

/**
 * Default elastic padding weights (extra virtual-character time per marker).
 * Spec anchors: '.' = 4, ',' = 2, '?' = 4, '\n' = 3. The rest are sensible siblings.
 */
export const DEFAULT_PUNCTUATION_WEIGHTS = Object.freeze({
  charWeight: 1, // time contributed per literal character
  ".": 4,
  "!": 4,
  "?": 4,
  "…": 4,
  ",": 2,
  ";": 2,
  ":": 2,
  "—": 2, // em dash
  "–": 2, // en dash
  "\n": 3,
});

/**
 * Compute the structural weight of one slide's text.
 * Exported for unit testing of the weighting in isolation.
 *
 * @param {string} text
 * @param {Record<string,number>} [weights]
 * @returns {number}
 */
export function punctuationWeight(text, weights = DEFAULT_PUNCTUATION_WEIGHTS) {
  const t = typeof text === "string" ? text : "";
  const charWeight = Number.isFinite(weights.charWeight) ? weights.charWeight : 1;
  let score = t.length * charWeight;
  for (let i = 0; i < t.length; i += 1) {
    const bonus = weights[t[i]];
    if (bonus) score += bonus;
  }
  return score;
}

/**
 * @param {Object} input
 * @param {import('./types.js').ChapterSlides[]} input.slidesByChapter
 * @param {number[]|Record<number,number>} input.chapterDurationsMs
 * @param {Record<string,number>} [input.weights]  Override the elastic padding weights.
 * @returns {import('./types.js').TimingResult}
 */
export function punctuationDensity({ slidesByChapter, chapterDurationsMs, weights = DEFAULT_PUNCTUATION_WEIGHTS }) {
  const spans = resolveChapterSpans(slidesByChapter, chapterDurationsMs);
  const weightOf = (s) => punctuationWeight(s.text, weights);

  /** @type {import('./types.js').ChapterTiming[]} */
  const chapters = slidesByChapter.map((ch, i) => {
    const { baseMs, durationMs } = spans[i];
    const slides = spanSlides(baseMs, durationMs, ch.slides, weightOf);
    return {
      chapter: ch.chapter,
      startMs: baseMs,
      endMs: baseMs + durationMs,
      durationMs,
      slides,
    };
  });

  return buildResult("punctuation", PUNCTUATION_MARKER, chapters, { strategy: "punctuation-density", weights });
}
