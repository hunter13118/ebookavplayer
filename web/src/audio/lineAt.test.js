import { describe, it, expect } from "vitest";
import { buildLineTimingIndex, buildMergedTimingIndex, chunkGap, lineAt } from "./lineAt.js";

const TIMELINE = {
  2: { startMs: 2000, endMs: 3000, durationMs: 1000 },
  0: { startMs: 0, endMs: 1000, durationMs: 1000 },
  1: { startMs: 1000, endMs: 2000, durationMs: 1000 },
};

describe("buildLineTimingIndex", () => {
  it("sorts entries by startMs regardless of Record key order", () => {
    const idx = buildLineTimingIndex(TIMELINE);
    expect(idx.map((e) => e.lineIndex)).toEqual([0, 1, 2]);
  });

  it("returns an empty array for null/undefined input", () => {
    expect(buildLineTimingIndex(null)).toEqual([]);
    expect(buildLineTimingIndex(undefined)).toEqual([]);
  });
});

describe("lineAt", () => {
  const idx = buildLineTimingIndex(TIMELINE);

  it("finds the exact line containing a timestamp", () => {
    expect(lineAt(idx, 0).lineIndex).toBe(0);
    expect(lineAt(idx, 500).lineIndex).toBe(0);
    expect(lineAt(idx, 1000).lineIndex).toBe(1);
    expect(lineAt(idx, 1999).lineIndex).toBe(1);
    expect(lineAt(idx, 2000).lineIndex).toBe(2);
  });

  it("clamps to the last line for a timestamp past the end", () => {
    expect(lineAt(idx, 999999).lineIndex).toBe(2);
  });

  it("clamps to the first line for a timestamp before the first line's start", () => {
    expect(lineAt(idx, -100).lineIndex).toBe(0);
  });

  it("returns null for an empty index", () => {
    expect(lineAt([], 500)).toBeNull();
    expect(lineAt(null, 500)).toBeNull();
  });

  it("handles a single-line index", () => {
    const single = buildLineTimingIndex({ 0: { startMs: 0, endMs: 1000, durationMs: 1000 } });
    expect(lineAt(single, 500).lineIndex).toBe(0);
    expect(lineAt(single, 999999).lineIndex).toBe(0);
  });
});

describe("buildMergedTimingIndex", () => {
  it("interleaves synthetic gap entries with real lines, sorted by startMs, without touching real lineIndex values", () => {
    const gaps = [{ id: "gap-0", startMs: 1500, endMs: 1900, text: "hey listener" }];
    const merged = buildMergedTimingIndex(TIMELINE, gaps);
    expect(merged.map((e) => e.lineIndex ?? e.syntheticId)).toEqual([0, 1, "gap-0", 2]);
    expect(merged.find((e) => e.syntheticId === "gap-0")).toEqual({
      lineIndex: null, syntheticId: "gap-0", startMs: 1500, endMs: 1900, text: "hey listener",
    });
  });

  it("lineAt() resolves into a synthetic entry the same way it does a real one", () => {
    const gaps = [{ id: "gap-0", startMs: 1500, endMs: 1900, text: "hey listener" }];
    const merged = buildMergedTimingIndex(TIMELINE, gaps);
    const entry = lineAt(merged, 1700);
    expect(entry.lineIndex).toBeNull();
    expect(entry.syntheticId).toBe("gap-0");
  });

  it("returns just the real timeline when there are no synthetic segments", () => {
    expect(buildMergedTimingIndex(TIMELINE, [])).toEqual(buildLineTimingIndex(TIMELINE));
    expect(buildMergedTimingIndex(TIMELINE, null)).toEqual(buildLineTimingIndex(TIMELINE));
  });

  it("chunks a long gap into several legible entries instead of one wall of text", () => {
    const longText = "This is Audible presents an original production. ".repeat(6).trim(); // > 160 chars
    const gap = { id: "gap-0", startMs: 1000, endMs: 3000, text: longText };
    const merged = buildMergedTimingIndex({}, [gap]);

    expect(merged.length).toBeGreaterThan(1);
    expect(merged.map((e) => e.syntheticId)).toEqual(merged.map((e, i) => `gap-0-${i}`));
    // Zero-drift: sub-durations must sum exactly to the gap's own duration.
    const totalDuration = merged.reduce((sum, e) => sum + (e.endMs - e.startMs), 0);
    expect(totalDuration).toBe(gap.endMs - gap.startMs);
    expect(merged[0].startMs).toBe(gap.startMs);
    expect(merged[merged.length - 1].endMs).toBe(gap.endMs);
    // Every chunk's text is a real (trimmed) slice of the original.
    expect(merged.map((e) => e.text).join(" ").replace(/\s+/g, " ")).toBe(longText.replace(/\s+/g, " "));
  });

  it("keeps a short gap's original id/span unchanged (single chunk)", () => {
    const gap = { id: "gap-0", startMs: 150, endMs: 180, text: "hey listener, bonus scene" };
    const merged = buildMergedTimingIndex({}, [gap]);
    expect(merged).toEqual([{ lineIndex: null, syntheticId: "gap-0", startMs: 150, endMs: 180, text: gap.text }]);
  });
});

describe("chunkGap", () => {
  it("is exported so UI code can compute a gap's first chunk id without re-implementing the splitter", () => {
    const gap = { id: "gap-0", startMs: 0, endMs: 100, text: "short" };
    expect(chunkGap(gap)).toEqual([{ lineIndex: null, syntheticId: "gap-0", startMs: 0, endMs: 100, text: "short" }]);
  });
});
