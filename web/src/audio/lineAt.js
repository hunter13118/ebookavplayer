// Maps "where is the real audio playhead right now" to "which line is that"
// for Mode B (continuous acoustic playback). lineTimings itself stays the
// existing Record<number,{startMs,endMs,durationMs}> shape everything else
// uses — this builds a derived, once-per-timeline sorted array view so
// lookups during playback (once per animation frame) are O(log n) instead
// of an O(n) scan of the Record every tick.

import { splitTextChunksWithOffsets, TTS_CHUNK_MAX_CHARS } from "./ttsChunks.js";
import { distributeProportional } from "../timing/distribute.js";

/** Build a startMs-sorted array of {lineIndex, startMs, endMs} from a lineTimings Record. */
export function buildLineTimingIndex(lineTimings) {
  return Object.keys(lineTimings || {})
    .map((k) => {
      const t = lineTimings[k];
      return { lineIndex: Number(k), startMs: t.startMs, endMs: t.endMs };
    })
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Split one gap's text into character-limited chunks (same splitter Mode A
 * uses for per-line TTS) and slice its [startMs,endMs) span across them
 * proportionally by char count, zero-drift (see timing/distribute.js). A
 * gap short enough to be a single chunk keeps its original id/span exactly
 * as before; a long one gets `${gap.id}-0`, `${gap.id}-1`, ... — this is
 * what turns a long "narration not in the book" passage into several
 * legible slides instead of one wall of text.
 */
export function chunkGap(g) {
  const parts = splitTextChunksWithOffsets(g.text, TTS_CHUNK_MAX_CHARS);
  if (parts.length <= 1) {
    return [{
      lineIndex: null, syntheticId: g.id, startMs: g.startMs, endMs: g.endMs, text: parts[0]?.text ?? g.text,
    }];
  }
  const weights = parts.map((p) => Math.max(1, p.text.length));
  const { boundaries } = distributeProportional(g.endMs - g.startMs, weights);
  return parts.map((p, i) => ({
    lineIndex: null,
    syntheticId: `${g.id}-${i}`,
    startMs: g.startMs + boundaries[i],
    endMs: g.startMs + boundaries[i + 1],
    text: p.text,
  }));
}

/**
 * Merge real line timings with synthetic "gap" entries (audio-only content
 * with no book-line counterpart — see whisperxAlignerClient.js) into ONE
 * startMs-sorted timeline for lineAt() to search. Deliberately does NOT
 * splice synthetic entries into the real `lines[]` array anywhere — several
 * call sites (chapter navigation, slide index assignment) assume line-array
 * indices are stable/contiguous, so this stays a derived, playback-only
 * view keyed by timestamp instead. `lineIndex: null` marks a synthetic
 * entry; the orchestrator checks for that to tell the two apart. Each gap
 * is chunked (see chunkGap()) so long passages surface as several
 * consecutive entries rather than one.
 */
export function buildMergedTimingIndex(lineTimings, syntheticSegments) {
  const real = buildLineTimingIndex(lineTimings);
  const synthetic = (syntheticSegments || []).flatMap(chunkGap);
  return [...real, ...synthetic].sort((a, b) => a.startMs - b.startMs);
}

/**
 * Binary search: the last entry whose startMs <= timeMs. Before the first
 * line's start (or an empty index) this clamps to the first entry (or null
 * if there are none) rather than returning nothing — real audio may have a
 * moment of lead-in silence before the first line's acoustic timestamp.
 */
export function lineAt(sortedEntries, timeMs) {
  if (!sortedEntries || !sortedEntries.length) return null;
  let lo = 0;
  let hi = sortedEntries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sortedEntries[mid].startMs <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  return sortedEntries[lo];
}
