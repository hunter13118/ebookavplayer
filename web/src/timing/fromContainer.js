// Glue between a single attached .m4b Blob and the four-tier timing engine:
// scans the container once, then resolves whichever algorithm the user
// picked against the result. Algorithms 1/2 (linear/punctuation) need a
// per-CHAPTER duration to distribute within; a single shared .m4b only
// trivially gives the algorithm-3 path (container chapter markers) that.
// When markers are usable we derive each chapter's span from consecutive
// marker deltas. When they aren't (no chpl, or a count mismatch), we
// distribute the container's total duration across chapters by character
// count — using the SAME zero-drift distributor as everything else, so the
// "no native markers" fallback still sums to the container's real total
// duration exactly, even though individual chapter boundaries are a guess.

import { scan } from "./moovAtomScanner.js";
import { distributeProportional } from "./distribute.js";
import { computeTimeline } from "./registry.js";

/**
 * @param {import('./types.js').ChapterSlides[]} slidesByChapter
 * @param {import('./types.js').ContainerInfo} containerInfo
 * @returns {number[]} per-chapter duration in ms, aligned to slidesByChapter order
 */
export function resolveChapterDurationsFromContainer(slidesByChapter, containerInfo) {
  const totalMs = containerInfo?.durationMs || 0;
  const markers = containerInfo?.chapters || [];

  if (containerInfo?.hasChapters && markers.length === slidesByChapter.length) {
    return markers.map((m, i) => {
      const end = i + 1 < markers.length ? markers[i + 1].startMs : totalMs;
      return Math.max(0, end - m.startMs);
    });
  }

  // No usable native chapter markers — fall back to a character-count-weighted
  // split of the total duration so chapter spans are at least proportional to
  // how much text each one has, with the same zero-drift guarantee as the
  // line-level distributor (sums to exactly totalMs).
  const charCounts = slidesByChapter.map((c) => c.slides.reduce((a, s) => a + s.charCount, 0));
  return distributeProportional(totalMs, charCounts).durations;
}

/**
 * Scan an attached .m4b and compute a timeline for the chosen algorithm.
 *
 * @param {Object} input
 * @param {Blob} input.blob               The attached .m4b file.
 * @param {import('./types.js').ChapterSlides[]} input.slidesByChapter
 * @param {string} input.algorithmId      'linear' | 'punctuation' | 'moov-atom' | 'whisperx'
 * @param {{baseUrl:string}} [input.connection]  Required when algorithmId is 'whisperx'.
 * @param {(chapter:number, total:number) => void} [input.onChapterProgress]
 * @param {(partial: Record<number,{startMs:number,endMs:number,durationMs:number}>) => void} [input.onLinesReady]
 *        whisperx path only — fires per newly-resolved batch of real line
 *        timings, well before the whole book finishes aligning.
 * @param {(newGaps: Array<{id:string,startMs:number,endMs:number,text:string}>) => void} [input.onGapsReady]
 *        whisperx path only — fires per newly-resolved batch of gap
 *        ("narrator filler") segments.
 * @param {typeof fetch} [input.fetchImpl]  Injectable for tests (whisperx path only).
 * @returns {Promise<import('./types.js').TimingResult & { containerInfo: import('./types.js').ContainerInfo }>}
 */
export async function computeTimelineFromM4b({
  blob, slidesByChapter, algorithmId, connection, onChapterProgress, onLinesReady, onGapsReady, fetchImpl,
}) {
  const containerInfo = await scan(blob);

  if (algorithmId === "moov-atom") {
    const result = await computeTimeline("moov-atom", { slidesByChapter, containerInfo });
    return { ...result, containerInfo };
  }

  if (algorithmId === "whisperx") {
    // Needs the real audio bytes directly (transcription happens server-side,
    // matched against the whole book at once) — not a per-chapter duration
    // split like the text-heuristic algorithms below. containerInfo isn't
    // needed here: real boundaries fall out of the acoustic match itself.
    const result = await computeTimeline("whisperx", {
      blob, slidesByChapter, connection, onChapterProgress, onLinesReady, onGapsReady, fetchImpl,
    });
    return { ...result, containerInfo };
  }

  const chapterDurationsMs = resolveChapterDurationsFromContainer(slidesByChapter, containerInfo);
  const result = await computeTimeline(algorithmId, { slidesByChapter, chapterDurationsMs });
  return { ...result, containerInfo };
}
