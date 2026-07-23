import { describe, it, expect } from "vitest";
import { hasM4bFirstTiming, m4bFirstTimelineFromBook, M4B_FIRST_MARKER } from "./m4bFirstTimeline.js";

function line(idx, startMs, endMs, words) {
  return { idx, text: `line ${idx}`, startMs, endMs, words };
}

describe("hasM4bFirstTiming", () => {
  it("is true when every line carries startMs/endMs", () => {
    const book = { scenes: [{ lines: [line(0, 0, 100), line(1, 100, 200)] }] };
    expect(hasM4bFirstTiming(book)).toBe(true);
  });
  it("is false for an empty book (transcription just started)", () => {
    expect(hasM4bFirstTiming({ scenes: [{ lines: [] }] })).toBe(false);
  });
  it("is false when any line is missing timing (a normal extracted book)", () => {
    const book = { scenes: [{ lines: [{ idx: 0, text: "x" }] }] };
    expect(hasM4bFirstTiming(book)).toBe(false);
  });
});

describe("m4bFirstTimelineFromBook", () => {
  it("builds lineTimings directly from each line's own timing, across scenes", () => {
    const book = {
      scenes: [
        { lines: [line(0, 0, 500, [["a", 0, 500]])] },
        { lines: [line(1, 500, 1200)] },
      ],
    };
    const result = m4bFirstTimelineFromBook(book);
    expect(result.meta).toEqual({ strategy: "acoustic", marker: M4B_FIRST_MARKER });
    expect(result.lineTimings).toEqual({
      0: { startMs: 0, endMs: 500, durationMs: 500, words: [["a", 0, 500]] },
      1: { startMs: 500, endMs: 1200, durationMs: 700, words: undefined },
    });
  });
  it("returns null when the book isn't M4B-first-timed", () => {
    expect(m4bFirstTimelineFromBook({ scenes: [{ lines: [{ idx: 0, text: "x" }] }] })).toBeNull();
  });
});
