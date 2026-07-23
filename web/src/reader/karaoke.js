// Pure karaoke-timing logic for the M4B-first minimal reader: given the audio
// playhead (ms) and a transcript, answer "which sentence is being spoken, which
// word within it, and how far through that word are we" — the three facts the
// reader needs to bolden the active sentence and typewriter-reveal it word by
// word in sync with the narration. No DOM, no React: kept pure so it's unit
// tested directly (pagination + rendering are separate concerns).
//
// A transcript line is { idx, text, startMs, endMs, words } where words is
// [[word, startMs, endMs], ...]. Lines are contiguous and startMs-sorted, so a
// line's array position IS its idx.

import { lineAt } from "../audio/lineAt.js";

/** Build the startMs-sorted lookup lineAt() searches (once per transcript). */
export function buildLineIndex(lines) {
  return (lines || []).map((ln, i) => ({ startMs: ln.startMs, endMs: ln.endMs, lineIndex: i }));
}

/**
 * Index of the sentence being spoken at currentMs. Uses the same
 * last-start<=t binary search as Mode B playback (audio/lineAt.js), so a
 * moment of lead-in silence before the first word clamps to line 0 rather
 * than returning nothing. Returns -1 only for an empty transcript.
 */
export function activeLineIndex(lineIndex, currentMs) {
  const hit = lineAt(lineIndex, currentMs);
  return hit ? hit.lineIndex : -1;
}

/**
 * How many words of a line have STARTED being spoken by currentMs (0..words.length).
 * words[revealCount-1] is the last word begun; words[revealCount] hasn't started.
 * This is the bolden boundary: words before it are fully spoken/bold, the one
 * at revealCount-1 is mid-utterance (the active word), the rest are dim.
 */
export function wordsStartedBy(words, currentMs) {
  if (!words || !words.length) return 0;
  // Binary search for the last word whose start <= currentMs, +1 for a count.
  let lo = 0;
  let hi = words.length; // exclusive; result is in [0, length]
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid][1] <= currentMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Reveal state for one line at currentMs, for the karaoke render.
 * - activeWord: index of the word currently being spoken (-1 before the first).
 * - spokenCount: words fully or partially begun (activeWord+1, or 0).
 * - wordProgress: 0..1 through the active word (drives the smooth wipe/typewriter).
 * Clamps sensibly before the line starts (nothing revealed) and after it ends
 * (everything revealed), so a line that's fully in the past renders fully bold.
 */
export function lineReveal(line, currentMs) {
  const words = line?.words || [];
  if (!words.length) {
    // No per-word timings — fall back to whole-line progress so the sentence
    // still boldens smoothly across its own [startMs,endMs) span.
    const span = Math.max(1, (line?.endMs ?? 0) - (line?.startMs ?? 0));
    const p = clamp01((currentMs - (line?.startMs ?? 0)) / span);
    return { activeWord: -1, spokenCount: 0, wordProgress: p, lineProgress: p };
  }
  const started = wordsStartedBy(words, currentMs);
  if (started === 0) return { activeWord: -1, spokenCount: 0, wordProgress: 0, lineProgress: 0 };
  const activeWord = started - 1;
  const [, wStart, wEnd] = words[activeWord];
  const wordProgress = clamp01((currentMs - wStart) / Math.max(1, wEnd - wStart));
  return {
    activeWord,
    spokenCount: started,
    wordProgress,
    lineProgress: clamp01(started / words.length),
  };
}

/**
 * Reveal state derived from a CHARACTER count, not a clock — the orchestrator
 * emits `revealed` (chars of the current line typewritten so far) in EVERY
 * playback mode (Edge TTS, silent estimate, and acoustic m4b alike), so this is
 * the uniform basis for the reader's word bolden across all audio sources. The
 * line's own text is split on whitespace; the active word is the one containing
 * the `revealed` boundary, and wordProgress is how far into that word the
 * boundary sits (smooth wipe).
 *
 * @param {string} text          The line's full text.
 * @param {number} revealedChars Characters revealed so far (orchestrator `revealed`).
 * @returns {{words:string[], activeWord:number, spokenCount:number, wordProgress:number}}
 */
export function revealFromChars(text, revealedChars) {
  const src = text || "";
  const words = [];
  const spans = []; // [startChar, endChar) of each word in src
  const re = /\S+/g;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(src))) {
    words.push(m[0]);
    spans.push([m.index, m.index + m[0].length]);
  }
  const r = Math.max(0, revealedChars || 0);
  if (!words.length) return { words, activeWord: -1, spokenCount: 0, wordProgress: 0 };
  if (r >= src.length) {
    return { words, activeWord: words.length - 1, spokenCount: words.length, wordProgress: 1 };
  }
  // The active word is the last one whose start is < r (i.e. reveal has reached
  // into or past it); words fully before r are spoken, the one straddling r is
  // active. Before the first word's start, nothing is revealed.
  let active = -1;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i][0] < r) active = i;
    else break;
  }
  if (active < 0) return { words, activeWord: -1, spokenCount: 0, wordProgress: 0 };
  const [s, e] = spans[active];
  const wordProgress = clamp01((r - s) / Math.max(1, e - s));
  return { words, activeWord: active, spokenCount: active, wordProgress };
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
