import { describe, it, expect } from "vitest";
import { computeTimelineFromM4b, resolveChapterDurationsFromContainer } from "./fromContainer.js";
import { buildSlidesByChapter } from "./slides.js";

function book(scenes) {
  return { scenes };
}

const TWO_CHAPTER_SBC = buildSlidesByChapter(book([
  { chapter: 1, lines: [{ text: "a" }, { text: "bb" }] },
  { chapter: 2, lines: [{ text: "ccc" }] },
]));

describe("resolveChapterDurationsFromContainer", () => {
  it("derives per-chapter durations from aligned native chapter markers", () => {
    const containerInfo = {
      moovFound: true, durationMs: 10000, hasChapters: true,
      chapters: [{ index: 0, startMs: 0, title: "C1" }, { index: 1, startMs: 6000, title: "C2" }],
    };
    const durations = resolveChapterDurationsFromContainer(TWO_CHAPTER_SBC, containerInfo);
    expect(durations).toEqual([6000, 4000]);
    expect(durations.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it("falls back to a character-count-weighted zero-drift split when markers are missing", () => {
    const containerInfo = { moovFound: true, durationMs: 9000, hasChapters: false, chapters: [] };
    const durations = resolveChapterDurationsFromContainer(TWO_CHAPTER_SBC, containerInfo);
    expect(durations.reduce((a, b) => a + b, 0)).toBe(9000);
    // Chapter 1 has 3 chars (a + bb), chapter 2 has 3 chars (ccc) -> even split.
    expect(durations).toEqual([4500, 4500]);
  });

  it("falls back when the marker count doesn't match the script chapter count", () => {
    const containerInfo = {
      moovFound: true, durationMs: 9000, hasChapters: true,
      chapters: [{ index: 0, startMs: 0, title: "Only one marker" }],
    };
    const durations = resolveChapterDurationsFromContainer(TWO_CHAPTER_SBC, containerInfo);
    expect(durations.reduce((a, b) => a + b, 0)).toBe(9000);
  });

  it("handles a zero-duration / not-found container without throwing", () => {
    const durations = resolveChapterDurationsFromContainer(TWO_CHAPTER_SBC, { moovFound: false, durationMs: 0, hasChapters: false, chapters: [] });
    expect(durations).toEqual([0, 0]);
  });

  it("handles a missing/undefined containerInfo without throwing", () => {
    expect(() => resolveChapterDurationsFromContainer(TWO_CHAPTER_SBC, undefined)).not.toThrow();
  });

  it("handles a single-chapter book", () => {
    const sbc = buildSlidesByChapter(book([{ chapter: 1, lines: [{ text: "only" }] }]));
    const durations = resolveChapterDurationsFromContainer(sbc, { moovFound: true, durationMs: 5000, hasChapters: false, chapters: [] });
    expect(durations).toEqual([5000]);
  });
});

// --- Minimal ISO-BMFF fixture builders (mirrors moovAtomScanner.test.js) ---
const enc = new TextEncoder();
function atom(type, payload) {
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size, false);
  out.set(enc.encode(type), 4);
  out.set(payload, 8);
  return out;
}
function concat(arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function mvhd(timescale, duration) {
  const p = new Uint8Array(100);
  const dv = new DataView(p.buffer);
  dv.setUint32(12, timescale, false);
  dv.setUint32(16, duration, false);
  return atom("mvhd", p);
}
function chpl(entries) {
  const parts = [new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, entries.length])];
  for (const [ms, title] of entries) {
    const t = enc.encode(title);
    const head = new Uint8Array(9);
    const dv = new DataView(head.buffer);
    const units = ms * 10000;
    dv.setUint32(0, Math.floor(units / 0x100000000), false);
    dv.setUint32(4, units >>> 0, false);
    head[8] = t.length;
    parts.push(head, t);
  }
  return atom("chpl", concat(parts));
}
const ftyp = atom("ftyp", enc.encode("M4A mp42M4A "));
const moov = (ts, dur, chapters) => atom("moov", concat([mvhd(ts, dur), atom("udta", chpl(chapters))]));
function blobOf(u8) {
  return { size: u8.length, slice: (s, e) => ({ arrayBuffer: async () => u8.slice(Math.max(0, s), Math.max(0, e)).buffer }) };
}

describe("computeTimelineFromM4b", () => {
  it("scans a real .m4b fixture and resolves a linear timeline with zero drift", async () => {
    const blob = blobOf(concat([ftyp, moov(1000, 10000, [[0, "C1"], [6000, "C2"]])]));
    const result = await computeTimelineFromM4b({ blob, slidesByChapter: TWO_CHAPTER_SBC, algorithmId: "linear" });
    expect(result.algorithm).toBe("linear");
    expect(result.containerInfo.moovFound).toBe(true);
    const sum = Object.values(result.lineTimings).reduce((a, t) => a + t.durationMs, 0);
    expect(sum).toBe(10000);
  });

  it("uses moovAtomTiming directly for the moov-atom algorithm (chapter-snapped)", async () => {
    const blob = blobOf(concat([ftyp, moov(1000, 10000, [[0, "C1"], [6000, "C2"]])]));
    const result = await computeTimelineFromM4b({ blob, slidesByChapter: TWO_CHAPTER_SBC, algorithmId: "moov-atom" });
    expect(result.algorithm).toBe("moov-atom");
    expect(result.meta.snapped).toBe(true);
    expect(result.lineTimings[0].startMs).toBe(0);
  });

  it("resolves a punctuation timeline scanning the same container", async () => {
    const blob = blobOf(concat([ftyp, moov(1000, 10000, [[0, "C1"], [6000, "C2"]])]));
    const result = await computeTimelineFromM4b({ blob, slidesByChapter: TWO_CHAPTER_SBC, algorithmId: "punctuation" });
    expect(result.algorithm).toBe("punctuation");
    const sum = Object.values(result.lineTimings).reduce((a, t) => a + t.durationMs, 0);
    expect(sum).toBe(10000);
  });

  it("degrades gracefully (zero-duration result, no throw) when the blob has no moov at all", async () => {
    const blob = blobOf(concat([ftyp, atom("mdat", new Uint8Array(100))]));
    const result = await computeTimelineFromM4b({ blob, slidesByChapter: TWO_CHAPTER_SBC, algorithmId: "linear" });
    expect(result.containerInfo.moovFound).toBe(false);
    expect(result.totalDurationMs).toBe(0);
  });
});
