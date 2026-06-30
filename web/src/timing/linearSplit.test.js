import { describe, it, expect } from "vitest";
import { linearSplit, LINEAR_MARKER } from "./linearSplit.js";
import { buildSlidesByChapter } from "./slides.js";

function book(scenes) {
  return { scenes };
}

describe("linearSplit", () => {
  it("tags output with the naive-linear-fallback marker", () => {
    const sbc = buildSlidesByChapter(book([{ chapter: 1, lines: [{ text: "hi" }] }]));
    const result = linearSplit({ slidesByChapter: sbc, chapterDurationsMs: [1000] });
    expect(result.algorithm).toBe("linear");
    expect(result.marker).toBe(LINEAR_MARKER);
    expect(result.marker).toBe("naive-linear-fallback");
  });

  it("splits a chapter's duration proportionally to character count with zero drift", () => {
    const sbc = buildSlidesByChapter(
      book([{ chapter: 1, lines: [{ text: "ab" }, { text: "abcdefgh" }] }]) // 2 vs 8 chars
    );
    const result = linearSplit({ slidesByChapter: sbc, chapterDurationsMs: [1000] });
    const sum = Object.values(result.lineTimings).reduce((a, t) => a + t.durationMs, 0);
    expect(sum).toBe(1000);
    // 2:8 ratio => roughly 200ms vs 800ms
    expect(result.lineTimings[0].durationMs).toBe(200);
    expect(result.lineTimings[1].durationMs).toBe(800);
  });

  it("holds zero drift across multiple chapters, each summing independently", () => {
    const sbc = buildSlidesByChapter(
      book([
        { chapter: 1, lines: [{ text: "a" }, { text: "bb" }, { text: "ccc" }] },
        { chapter: 2, lines: [{ text: "dddd" }] },
      ])
    );
    const result = linearSplit({ slidesByChapter: sbc, chapterDurationsMs: [12345, 6789] });
    expect(result.chapters[0].slides.reduce((a, s) => a + s.durationMs, 0)).toBe(12345);
    expect(result.chapters[1].slides.reduce((a, s) => a + s.durationMs, 0)).toBe(6789);
  });

  it("accepts a chapterDurationsMs map keyed by chapter number", () => {
    const sbc = buildSlidesByChapter(book([{ chapter: 7, lines: [{ text: "hello" }] }]));
    const result = linearSplit({ slidesByChapter: sbc, chapterDurationsMs: { 7: 5000 } });
    expect(result.lineTimings[0].durationMs).toBe(5000);
  });

  it("falls back to an even split within a chapter where every line is empty", () => {
    const sbc = buildSlidesByChapter(book([{ chapter: 1, lines: [{ text: "" }, { text: "" }] }]));
    const result = linearSplit({ slidesByChapter: sbc, chapterDurationsMs: [1000] });
    expect(result.lineTimings[0].durationMs).toBe(500);
    expect(result.lineTimings[1].durationMs).toBe(500);
  });

  it("produces a complete lineTimings lookup with every line index present", () => {
    const sbc = buildSlidesByChapter(
      book([{ chapter: 1, lines: [{ text: "a" }, { text: "b" }, { text: "c" }] }])
    );
    const result = linearSplit({ slidesByChapter: sbc, chapterDurationsMs: [900] });
    expect(Object.keys(result.lineTimings).map(Number).sort()).toEqual([0, 1, 2]);
  });

  it("throws if a chapter's duration cannot be resolved (malformed input)", () => {
    const sbc = buildSlidesByChapter(book([{ chapter: 1, lines: [{ text: "a" }] }]));
    expect(() => linearSplit({ slidesByChapter: sbc, chapterDurationsMs: [] })).toThrow();
  });
});
