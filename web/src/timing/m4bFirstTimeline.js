// M4B-first exact timeline — the fast path for a book whose lines carry
// their OWN precise start/end (and word) timings directly, because they came
// FROM the attached .m4b in the first place (transcribeM4b, see
// docs/M4B_FIRST_FLOW.md), rather than being aligned/estimated against it
// after the fact. Unlike the four algorithms in this directory (linear,
// punctuation, moov-atom, whisperx), there's nothing to compute here — the
// timing already IS the ground truth the book was built from.

export const M4B_FIRST_MARKER = "m4b-first-transcript";

/** True if every line in `book` carries the startMs/endMs markers
 *  installM4bFirstBook's lines are built with (m4bFirstBooks.js). A book
 *  with zero lines (transcription just started) is NOT eligible — there's
 *  nothing to build a timeline from yet, and the caller should fall back to
 *  the normal attach-.m4b estimate/alignment path once it exists. */
export function hasM4bFirstTiming(book) {
  const lines = (book?.scenes || []).flatMap((s) => s.lines || []);
  return lines.length > 0 && lines.every((l) => l.startMs != null && l.endMs != null);
}

/**
 * Build a TimingResult-shaped { lineTimings, meta } straight from the book's
 * own line timing fields — no estimation, no acoustic scan.
 * @param {object} book  A compiled/local-pack book whose lines carry startMs/endMs/words.
 * @returns {{lineTimings: Record<number,{startMs:number,endMs:number,durationMs:number,words?:Array}>, meta: object}|null}
 */
export function m4bFirstTimelineFromBook(book) {
  if (!hasM4bFirstTiming(book)) return null;
  const lineTimings = {};
  let globalIdx = 0;
  for (const scene of book.scenes || []) {
    for (const line of scene.lines || []) {
      const startMs = Math.round(line.startMs);
      const endMs = Math.max(startMs, Math.round(line.endMs));
      lineTimings[globalIdx] = { startMs, endMs, durationMs: endMs - startMs, words: line.words };
      globalIdx += 1;
    }
  }
  return { lineTimings, meta: { strategy: "acoustic", marker: M4B_FIRST_MARKER } };
}
