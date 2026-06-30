// The mathematical core shared by Algorithms 1 (linear), 2 (punctuation) and the
// per-chapter sub-distribution of Algorithm 3 (moov-atom).
//
// THE ZERO-DRIFT GUARANTEE
// ------------------------
// Given a chapter's total duration `totalMs` and a non-negative weight per slide,
// assign integer-millisecond [start,end] boundaries such that:
//   * every boundary is a non-decreasing integer,
//   * sum(durations) === totalMs  EXACTLY (not "within a rounding tolerance"),
//   * no fractional millisecond ever leaks or accumulates across slides.
//
// The trick is cumulative-boundary rounding, NOT per-slide rounding. We round each
// CUMULATIVE boundary against the global total, then take adjacent differences.
// Because the final cumulative weight equals the total weight, the final boundary
// rounds to exactly `totalMs`, so the durations are guaranteed to sum to `totalMs`
// with zero drift — even across a 10-hour book with tens of thousands of slides.

/**
 * Distribute `totalMs` across N slides proportionally to `weights`, with zero drift.
 *
 * @param {number} totalMs           Integer milliseconds to distribute (>= 0).
 * @param {number[]} weights         Non-negative weight per slide.
 * @returns {{ durations:number[], boundaries:number[] }}
 *   `durations[i]` is slide i's integer ms duration; `boundaries` has length N+1 with
 *   boundaries[0] === 0 and boundaries[N] === totalMs. Slide i spans
 *   [boundaries[i], boundaries[i+1]).
 * @throws {RangeError} if totalMs < 0 or any weight is negative / non-finite.
 */
export function distributeProportional(totalMs, weights) {
  if (!Number.isFinite(totalMs) || totalMs < 0) {
    throw new RangeError(`distributeProportional: totalMs must be a finite >= 0 number, got ${totalMs}`);
  }
  const total = Math.round(totalMs);
  const n = weights.length;
  if (n === 0) return { durations: [], boundaries: [0] };

  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const w = weights[i];
    if (!Number.isFinite(w) || w < 0) {
      throw new RangeError(`distributeProportional: weight[${i}] must be finite >= 0, got ${w}`);
    }
    sum += w;
  }

  // Degenerate: no weight anywhere (e.g. every slide is empty text). Fall back to an
  // even split so playback still advances rather than parking on a single slide.
  const effective = sum > 0 ? weights : new Array(n).fill(1);
  const effectiveSum = sum > 0 ? sum : n;

  const boundaries = new Array(n + 1);
  boundaries[0] = 0;
  let cum = 0;
  for (let i = 0; i < n; i += 1) {
    cum += effective[i];
    // Round the CUMULATIVE position, not the slide. The last iteration has
    // cum === effectiveSum, so this evaluates to Math.round(total) === total.
    boundaries[i + 1] = Math.round((cum / effectiveSum) * total);
  }
  // boundaries is non-decreasing because cum is non-decreasing and Math.round is
  // monotonic; the final entry is exactly `total`.

  const durations = new Array(n);
  for (let i = 0; i < n; i += 1) {
    durations[i] = boundaries[i + 1] - boundaries[i];
  }
  return { durations, boundaries };
}

/**
 * Convenience: distribute and emit SlideTiming records offset by an absolute base.
 *
 * @param {number} baseMs            Absolute ms at which this chapter starts in the book.
 * @param {number} totalMs           This chapter's duration.
 * @param {import('./types.js').Slide[]} slides
 * @param {(slide: import('./types.js').Slide, index:number) => number} weightOf
 * @returns {import('./types.js').SlideTiming[]}
 */
export function spanSlides(baseMs, totalMs, slides, weightOf) {
  const weights = slides.map((s, i) => weightOf(s, i));
  const { boundaries } = distributeProportional(totalMs, weights);
  return slides.map((s, i) => {
    const startMs = baseMs + boundaries[i];
    const endMs = baseMs + boundaries[i + 1];
    return {
      lineIndex: s.lineIndex,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      charCount: s.charCount,
      weight: weights[i],
    };
  });
}
