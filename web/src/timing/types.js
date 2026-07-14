// Shared type contract for the four-tier audiobook→script timing engine.
// Pure JSDoc — no runtime. Imported via `import('./types.js')` typedefs.
//
// VOCABULARY (adapted from the generic spec to THIS codebase):
//   "chapter" -> scene.chapter (integer). Source of truth: chapterNav.buildChapterIndex.
//   "slide"   -> a single `line` (the unit that advances on screen / orchestrator st.index).
//                NOT a scene. Scenes are visual backdrops that change occasionally.
//   timing is keyed on the GLOBAL, zero-based line index (same index the orchestrator,
//   resume state, and seek all use).

/**
 * One displayed text unit (a line) the engine assigns a time span to.
 * @typedef {Object} Slide
 * @property {number} lineIndex  Global zero-based index in the flattened lines array.
 * @property {number} chapter    The scene.chapter this line belongs to.
 * @property {string} text       Raw line text (may be empty).
 * @property {number} charCount  Raw text length (used by the naive linear algorithm).
 */

/**
 * Slides grouped under one chapter, in reading order.
 * @typedef {Object} ChapterSlides
 * @property {number} chapter
 * @property {Slide[]} slides
 */

/**
 * The time span assigned to a single slide. All values are integer milliseconds,
 * absolute from the start of the audiobook (so they can drive an audio seek), and
 * stored at playback speed = 1 (the orchestrator divides by speed at render time).
 * @typedef {Object} SlideTiming
 * @property {number} lineIndex
 * @property {number} startMs    Absolute start offset into the audiobook.
 * @property {number} endMs      Absolute end offset (exclusive).
 * @property {number} durationMs endMs - startMs.
 * @property {number} charCount
 * @property {number} [weight]   The structural weight used (punctuation algorithm).
 */

/**
 * The time span of one chapter plus its slide breakdown.
 * @typedef {Object} ChapterTiming
 * @property {number} chapter
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} durationMs
 * @property {SlideTiming[]} slides
 */

/**
 * The unified result every algorithm returns, regardless of tier.
 * @typedef {Object} TimingResult
 * @property {string} algorithm  Algorithm id (linear|punctuation|moov-atom|whisperx).
 * @property {string} marker     UI metadata tag (e.g. 'naive-linear-fallback').
 * @property {'line'} unit       Always 'line' in this codebase.
 * @property {number} totalDurationMs
 * @property {ChapterTiming[]} chapters
 * @property {Record<number, {startMs:number,endMs:number,durationMs:number}>} lineTimings
 *           Flat O(1) lookup keyed by global line index — what the orchestrator reads.
 * @property {Object} [meta]     Free-form: { degraded, source, weights, ... }.
 */

/**
 * Container facts extracted from an .m4b by the moov-atom scanner.
 * @typedef {Object} ContainerInfo
 * @property {boolean} moovFound
 * @property {number} timescale
 * @property {number} durationMs   Total media duration.
 * @property {boolean} hasChapters
 * @property {{index:number,startMs:number,title:string}[]} chapters
 * @property {'reverse-seek'|'forward-walk'|'none'} source  How moov was located.
 */

/**
 * A user-selectable algorithm in the multiple-choice config panel.
 * @typedef {Object} AlgorithmDescriptor
 * @property {string} id
 * @property {string} label
 * @property {string} marker
 * @property {'client'|'local-server'} tier
 * @property {string} blurb   One-line description for the settings UI.
 */

export {};
