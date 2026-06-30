import { describe, it, expect } from "vitest";
import {
  ALGORITHMS, DEFAULT_ALGORITHM, getAlgorithm, describeAlgorithms, isKnownAlgorithm, computeTimeline,
} from "./registry.js";
import { buildSlidesByChapter } from "./slides.js";

function book(scenes) {
  return { scenes };
}

describe("registry", () => {
  it("registers exactly the four specified algorithms", () => {
    expect(ALGORITHMS.map((a) => a.id).sort()).toEqual(
      ["forced-aligner", "linear", "moov-atom", "punctuation"].sort()
    );
  });

  it("defaults to linear", () => {
    expect(DEFAULT_ALGORITHM).toBe("linear");
  });

  it("getAlgorithm resolves a known id", () => {
    expect(getAlgorithm("punctuation").id).toBe("punctuation");
  });

  it("getAlgorithm falls back to the default for an unknown id", () => {
    expect(getAlgorithm("nonexistent-algorithm").id).toBe(DEFAULT_ALGORITHM);
  });

  it("isKnownAlgorithm distinguishes known vs unknown ids", () => {
    expect(isKnownAlgorithm("moov-atom")).toBe(true);
    expect(isKnownAlgorithm("bogus")).toBe(false);
  });

  it("describeAlgorithms strips the run() function (UI-safe descriptors only)", () => {
    const descriptors = describeAlgorithms();
    expect(descriptors).toHaveLength(4);
    for (const d of descriptors) {
      expect(d.run).toBeUndefined();
      expect(typeof d.id).toBe("string");
      expect(typeof d.label).toBe("string");
      expect(typeof d.marker).toBe("string");
      expect(["client", "local-server"]).toContain(d.tier);
      expect(typeof d.blurb).toBe("string");
    }
  });

  it("each algorithm has a unique marker", () => {
    const markers = ALGORITHMS.map((a) => a.marker);
    expect(new Set(markers).size).toBe(markers.length);
  });

  it("computeTimeline dispatches to the client algorithms synchronously-resolved via the same await contract", async () => {
    const sbc = buildSlidesByChapter(book([{ chapter: 1, lines: [{ text: "hi" }] }]));
    const result = await computeTimeline("linear", { slidesByChapter: sbc, chapterDurationsMs: [1000] });
    expect(result.algorithm).toBe("linear");
    expect(result.lineTimings[0].durationMs).toBe(1000);
  });

  it("computeTimeline falls back to the default algorithm for an unrecognized id", async () => {
    const sbc = buildSlidesByChapter(book([{ chapter: 1, lines: [{ text: "hi" }] }]));
    const result = await computeTimeline("not-a-real-algorithm", { slidesByChapter: sbc, chapterDurationsMs: [1000] });
    expect(result.algorithm).toBe(DEFAULT_ALGORITHM);
  });
});
