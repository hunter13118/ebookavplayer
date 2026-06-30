import { describe, it, expect } from "vitest";
import { buildSlidesByChapter, countSlides, buildResult, resolveChapterSpans } from "./slides.js";

function book(scenes) {
  return { scenes };
}

describe("buildSlidesByChapter", () => {
  it("flattens scenes into chapter-grouped slides preserving a global line index", () => {
    const b = book([
      { chapter: 1, lines: [{ text: "a" }, { text: "bb" }] },
      { chapter: 1, lines: [{ text: "ccc" }] },
      { chapter: 2, lines: [{ text: "dddd" }] },
    ]);
    const result = buildSlidesByChapter(b);
    expect(result.map((c) => c.chapter)).toEqual([1, 2]);
    expect(result[0].slides.map((s) => s.lineIndex)).toEqual([0, 1, 2]);
    expect(result[1].slides.map((s) => s.lineIndex)).toEqual([3]);
    expect(result[0].slides[1].text).toBe("bb");
    expect(result[0].slides[1].charCount).toBe(2);
  });

  it("handles an empty book (no scenes)", () => {
    expect(buildSlidesByChapter(book([]))).toEqual([]);
    expect(buildSlidesByChapter({})).toEqual([]);
    expect(buildSlidesByChapter(undefined)).toEqual([]);
  });

  it("handles scenes with no lines", () => {
    const result = buildSlidesByChapter(book([{ chapter: 1, lines: [] }]));
    expect(result).toEqual([]);
  });

  it("treats a missing/non-numeric chapter as chapter 0", () => {
    const result = buildSlidesByChapter(book([{ lines: [{ text: "x" }] }]));
    expect(result[0].chapter).toBe(0);
  });

  it("treats a missing/non-string text as an empty string (zero-text slide)", () => {
    const result = buildSlidesByChapter(book([{ chapter: 1, lines: [{}] }]));
    expect(result[0].slides[0].text).toBe("");
    expect(result[0].slides[0].charCount).toBe(0);
  });

  it("keeps a global line index across re-occurring (non-contiguous) chapter numbers", () => {
    // Chapter 1 appears, then 2, then 1 again — index must keep climbing globally,
    // and grouping is by first-seen order, mirroring chapterNav semantics.
    const b = book([
      { chapter: 1, lines: [{ text: "a" }] },
      { chapter: 2, lines: [{ text: "b" }] },
      { chapter: 1, lines: [{ text: "c" }] },
    ]);
    const result = buildSlidesByChapter(b);
    const ch1 = result.find((c) => c.chapter === 1);
    expect(ch1.slides.map((s) => s.lineIndex)).toEqual([0, 2]);
  });
});

describe("countSlides", () => {
  it("sums slides across all chapters", () => {
    const sbc = [
      { chapter: 1, slides: [{}, {}] },
      { chapter: 2, slides: [{}] },
    ];
    expect(countSlides(sbc)).toBe(3);
  });

  it("returns 0 for an empty list", () => {
    expect(countSlides([])).toBe(0);
  });
});

describe("buildResult", () => {
  it("builds a flat lineTimings lookup keyed by global line index", () => {
    const chapters = [
      {
        chapter: 1,
        startMs: 0,
        endMs: 100,
        durationMs: 100,
        slides: [
          { lineIndex: 0, startMs: 0, endMs: 40, durationMs: 40 },
          { lineIndex: 1, startMs: 40, endMs: 100, durationMs: 60 },
        ],
      },
    ];
    const result = buildResult("linear", "naive-linear-fallback", chapters, { foo: "bar" });
    expect(result.algorithm).toBe("linear");
    expect(result.marker).toBe("naive-linear-fallback");
    expect(result.unit).toBe("line");
    expect(result.totalDurationMs).toBe(100);
    expect(result.lineTimings[0]).toEqual({ startMs: 0, endMs: 40, durationMs: 40 });
    expect(result.lineTimings[1]).toEqual({ startMs: 40, endMs: 100, durationMs: 60 });
    expect(result.meta).toEqual({ foo: "bar" });
  });

  it("computes totalDurationMs as the max chapter endMs across multiple chapters", () => {
    const chapters = [
      { chapter: 1, startMs: 0, endMs: 100, durationMs: 100, slides: [] },
      { chapter: 2, startMs: 100, endMs: 250, durationMs: 150, slides: [] },
    ];
    const result = buildResult("linear", "m", chapters);
    expect(result.totalDurationMs).toBe(250);
  });

  it("handles zero chapters", () => {
    const result = buildResult("linear", "m", []);
    expect(result.totalDurationMs).toBe(0);
    expect(result.lineTimings).toEqual({});
  });

  it("defaults meta to an empty object", () => {
    const result = buildResult("linear", "m", []);
    expect(result.meta).toEqual({});
  });
});

describe("resolveChapterSpans", () => {
  const sbc = [
    { chapter: 1, slides: [] },
    { chapter: 2, slides: [] },
  ];

  it("resolves contiguous spans from an array of durations aligned to slidesByChapter order", () => {
    const spans = resolveChapterSpans(sbc, [1000, 2000]);
    expect(spans).toEqual([
      { chapter: 1, baseMs: 0, durationMs: 1000 },
      { chapter: 2, baseMs: 1000, durationMs: 2000 },
    ]);
  });

  it("resolves contiguous spans from a map keyed by chapter number", () => {
    const spans = resolveChapterSpans(sbc, { 1: 500, 2: 1500 });
    expect(spans).toEqual([
      { chapter: 1, baseMs: 0, durationMs: 500 },
      { chapter: 2, baseMs: 500, durationMs: 1500 },
    ]);
  });

  it("rounds fractional chapter durations", () => {
    const spans = resolveChapterSpans(sbc, [100.6, 50.4]);
    expect(spans[0].durationMs).toBe(101);
    expect(spans[1].baseMs).toBe(101);
  });

  it("throws when a chapter's duration is missing", () => {
    expect(() => resolveChapterSpans(sbc, [1000])).toThrow(/missing\/invalid duration/);
    expect(() => resolveChapterSpans(sbc, { 1: 1000 })).toThrow(/missing\/invalid duration/);
  });

  it("throws when a chapter's duration is negative", () => {
    expect(() => resolveChapterSpans(sbc, [-1, 100])).toThrow(/missing\/invalid duration/);
  });

  it("handles a single chapter spanning the whole book", () => {
    const single = [{ chapter: 1, slides: [] }];
    const spans = resolveChapterSpans(single, [12345]);
    expect(spans).toEqual([{ chapter: 1, baseMs: 0, durationMs: 12345 }]);
  });
});
