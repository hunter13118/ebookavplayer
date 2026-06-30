import { describe, it, expect } from "vitest";
import {
  punctuationDensity, punctuationWeight, DEFAULT_PUNCTUATION_WEIGHTS, PUNCTUATION_MARKER,
} from "./punctuationDensity.js";
import { buildSlidesByChapter } from "./slides.js";

function book(scenes) {
  return { scenes };
}

describe("punctuationWeight", () => {
  it("weighs a bare run of characters as charCount * charWeight", () => {
    expect(punctuationWeight("abcd")).toBe(4);
  });

  it("adds the default bonus for a period", () => {
    expect(punctuationWeight(".")).toBe(1 + 4);
  });

  it("adds the default bonus for a comma, question mark, and newline", () => {
    expect(punctuationWeight(",")).toBe(1 + 2);
    expect(punctuationWeight("?")).toBe(1 + 4);
    expect(punctuationWeight("\n")).toBe(1 + 3);
  });

  it("sums multiple punctuation bonuses within one slide", () => {
    // 4 chars + 1 period(4) + 1 comma(2) = 4 + 4 + 2 = 10
    expect(punctuationWeight("a,b.")).toBe(10);
  });

  it("EXTREME ANOMALY: a single short word outweighs nothing but its own chars", () => {
    expect(punctuationWeight("Indeed")).toBe(6);
  });

  it("EXTREME ANOMALY: a long run-on sentence packed with punctuation outweighs a single word by a wide margin", () => {
    const singleWord = "Indeed";
    const runOn = "Yes, well; really? Indeed, I suppose so, in the end — who's to say, truly?";
    expect(punctuationWeight(runOn)).toBeGreaterThan(punctuationWeight(singleWord) * 5);
  });

  it("EXTREME ANOMALY: an empty slide has zero weight", () => {
    expect(punctuationWeight("")).toBe(0);
    expect(punctuationWeight(undefined)).toBe(0);
    expect(punctuationWeight(null)).toBe(0);
  });

  it("EXTREME ANOMALY: a slide of pure punctuation (no letters at all) still gets a non-trivial weight", () => {
    expect(punctuationWeight("...")).toBe(3 * (1 + 4));
  });

  it("respects custom elastic weight overrides", () => {
    const custom = { charWeight: 1, ".": 100 };
    expect(punctuationWeight("a.", custom)).toBe(1 + 1 + 100);
  });

  it("treats an unlisted character as contributing only its base charWeight", () => {
    expect(punctuationWeight("$")).toBe(1);
  });
});

describe("punctuationDensity (engine)", () => {
  it("tags output with the punctuation-density-map marker", () => {
    const sbc = buildSlidesByChapter(book([{ chapter: 1, lines: [{ text: "Hi." }] }]));
    const result = punctuationDensity({ slidesByChapter: sbc, chapterDurationsMs: [1000] });
    expect(result.algorithm).toBe("punctuation");
    expect(result.marker).toBe(PUNCTUATION_MARKER);
    expect(result.marker).toBe("punctuation-density-map");
  });

  it("holds the zero-drift guarantee exactly like the linear algorithm", () => {
    const sbc = buildSlidesByChapter(
      book([{ chapter: 1, lines: [{ text: "A." }, { text: "A longer line, with several, commas!" }, { text: "" }] }])
    );
    const result = punctuationDensity({ slidesByChapter: sbc, chapterDurationsMs: [123456] });
    const sum = Object.values(result.lineTimings).reduce((a, t) => a + t.durationMs, 0);
    expect(sum).toBe(123456);
  });

  it("EXTREME ANOMALY: gives a heavily-punctuated slide more time than an equal-length plain slide", () => {
    const sbc = buildSlidesByChapter(
      book([{ chapter: 1, lines: [{ text: "Wait, stop, no, go!!" }, { text: "the cat sat on a mat" }] }])
    );
    // Both lines are exactly the same character length (20).
    const len0 = sbc[0].slides[0].charCount;
    const len1 = sbc[0].slides[1].charCount;
    expect(len0).toBe(len1);

    const result = punctuationDensity({ slidesByChapter: sbc, chapterDurationsMs: [1000] });
    expect(result.lineTimings[0].durationMs).toBeGreaterThan(result.lineTimings[1].durationMs);
  });

  it("EXTREME ANOMALY: a single-word slide vs a packed run-on sentence slide in the same chapter — zero drift still holds, run-on gets more time", () => {
    const sbc = buildSlidesByChapter(
      book([{
        chapter: 1,
        lines: [
          { text: "Indeed." },
          { text: "Yes, well; really? Indeed, I suppose so, in the end — who's to say, truly?" },
        ],
      }])
    );
    const result = punctuationDensity({ slidesByChapter: sbc, chapterDurationsMs: [9999] });
    const sum = result.chapters[0].slides.reduce((a, s) => a + s.durationMs, 0);
    expect(sum).toBe(9999);
    expect(result.lineTimings[1].durationMs).toBeGreaterThan(result.lineTimings[0].durationMs);
  });

  it("accepts a custom weights override and threads it through to every slide", () => {
    const sbc = buildSlidesByChapter(book([{ chapter: 1, lines: [{ text: "a." }, { text: "bb" }] }]));
    // Make '.' enormously expensive so the punctuated line dominates the split.
    const weights = { ...DEFAULT_PUNCTUATION_WEIGHTS, ".": 10_000 };
    const result = punctuationDensity({ slidesByChapter: sbc, chapterDurationsMs: [10_000], weights });
    expect(result.lineTimings[0].durationMs).toBeGreaterThan(result.lineTimings[1].durationMs * 10);
    expect(result.meta.weights).toBe(weights);
  });

  it("falls back to an even split when every slide in the chapter is empty text", () => {
    const sbc = buildSlidesByChapter(book([{ chapter: 1, lines: [{ text: "" }, { text: "" }] }]));
    const result = punctuationDensity({ slidesByChapter: sbc, chapterDurationsMs: [1000] });
    expect(result.lineTimings[0].durationMs).toBe(500);
    expect(result.lineTimings[1].durationMs).toBe(500);
  });
});
