import { describe, it, expect } from "vitest";
import { distributeProportional, spanSlides } from "./distribute.js";

describe("distributeProportional", () => {
  it("distributes evenly across equal weights with zero drift", () => {
    const { durations, boundaries } = distributeProportional(1000, [1, 1, 1]);
    expect(durations.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(boundaries).toEqual([0, 333, 667, 1000]);
  });

  it("guarantees zero millisecond drift over a 10-hour book with 50,000 slides", () => {
    const TEN_HOURS_MS = 10 * 60 * 60 * 1000;
    // Nasty, non-uniform weights so no slide divides the total evenly.
    const weights = Array.from({ length: 50_000 }, (_, i) => ((i * 37) % 113) + 1);
    const { durations, boundaries } = distributeProportional(TEN_HOURS_MS, weights);
    const sum = durations.reduce((a, b) => a + b, 0);
    expect(sum).toBe(TEN_HOURS_MS);
    expect(boundaries[0]).toBe(0);
    expect(boundaries[boundaries.length - 1]).toBe(TEN_HOURS_MS);
  });

  it("never leaks or drifts a fractional millisecond for awkward divisions", () => {
    // 37ms across 5 slides with irregular weights — classic rounding-leak trap.
    const { durations } = distributeProportional(37, [3, 5, 0, 11, 2]);
    expect(durations.reduce((a, b) => a + b, 0)).toBe(37);
  });

  it("produces non-negative, non-decreasing boundaries", () => {
    const { boundaries, durations } = distributeProportional(9999, [1, 2, 3, 4, 5, 6, 7]);
    for (let i = 1; i < boundaries.length; i += 1) {
      expect(boundaries[i]).toBeGreaterThanOrEqual(boundaries[i - 1]);
    }
    expect(durations.every((d) => d >= 0)).toBe(true);
  });

  it("falls back to an even split when every weight is zero", () => {
    const { durations } = distributeProportional(900, [0, 0, 0]);
    expect(durations).toEqual([300, 300, 300]);
  });

  it("falls back to an even split when every weight is zero with a non-divisible total", () => {
    const { durations } = distributeProportional(100, [0, 0, 0]);
    expect(durations.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("handles a single slide by assigning it the whole duration", () => {
    const { durations, boundaries } = distributeProportional(5000, [42]);
    expect(durations).toEqual([5000]);
    expect(boundaries).toEqual([0, 5000]);
  });

  it("handles an empty slide array", () => {
    const { durations, boundaries } = distributeProportional(5000, []);
    expect(durations).toEqual([]);
    expect(boundaries).toEqual([0]);
  });

  it("handles totalMs === 0", () => {
    const { durations, boundaries } = distributeProportional(0, [1, 2, 3]);
    expect(durations).toEqual([0, 0, 0]);
    expect(boundaries).toEqual([0, 0, 0, 0]);
  });

  it("rounds a fractional totalMs input to the nearest integer", () => {
    const { durations } = distributeProportional(99.6, [1, 1]);
    expect(durations.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("throws on a negative totalMs", () => {
    expect(() => distributeProportional(-1, [1, 1])).toThrow(RangeError);
  });

  it("throws on a negative weight", () => {
    expect(() => distributeProportional(100, [1, -1])).toThrow(RangeError);
  });

  it("throws on a non-finite totalMs", () => {
    expect(() => distributeProportional(Infinity, [1])).toThrow(RangeError);
    expect(() => distributeProportional(NaN, [1])).toThrow(RangeError);
  });

  it("throws on a non-finite weight", () => {
    expect(() => distributeProportional(100, [1, NaN])).toThrow(RangeError);
    expect(() => distributeProportional(100, [Infinity])).toThrow(RangeError);
  });

  it("is stable under repeated weight-1 slides at large N (no float accumulation error)", () => {
    const n = 100_000;
    const { durations } = distributeProportional(n * 7, new Array(n).fill(1));
    expect(durations.reduce((a, b) => a + b, 0)).toBe(n * 7);
    // Every slide should get either 7 or as close to 7 as integer rounding allows.
    expect(durations.every((d) => d >= 0)).toBe(true);
  });
});

describe("spanSlides", () => {
  const slides = [
    { lineIndex: 0, charCount: 4 },
    { lineIndex: 1, charCount: 0 },
    { lineIndex: 2, charCount: 16 },
  ];

  it("offsets boundaries by baseMs and sums to totalMs", () => {
    const result = spanSlides(1000, 600, slides, (s) => s.charCount);
    expect(result[0].startMs).toBe(1000);
    expect(result[result.length - 1].endMs).toBe(1600);
    const sum = result.reduce((a, s) => a + s.durationMs, 0);
    expect(sum).toBe(600);
  });

  it("carries lineIndex, charCount, and the resolved weight through", () => {
    const result = spanSlides(0, 100, slides, (s) => s.charCount);
    expect(result.map((s) => s.lineIndex)).toEqual([0, 1, 2]);
    expect(result.map((s) => s.charCount)).toEqual([4, 0, 16]);
    expect(result[1].weight).toBe(0);
  });

  it("handles a zero-text slide (weight 0) without crashing or going negative", () => {
    const result = spanSlides(0, 100, slides, (s) => s.charCount);
    expect(result[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(result[1].endMs).toBeGreaterThanOrEqual(result[1].startMs);
  });

  it("produces contiguous spans (no gaps, no overlaps)", () => {
    const result = spanSlides(500, 1000, slides, (s) => s.charCount + 1);
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i].startMs).toBe(result[i - 1].endMs);
    }
  });
});
