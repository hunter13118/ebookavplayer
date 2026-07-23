import { describe, it, expect } from "vitest";
import { buildLineIndex, activeLineIndex, wordsStartedBy, lineReveal, revealFromChars } from "./karaoke.js";

const LINES = [
  { idx: 0, text: "First sentence here.", startMs: 0, endMs: 1000,
    words: [["First", 0, 300], ["sentence", 300, 700], ["here.", 700, 1000]] },
  { idx: 1, text: "Second one now.", startMs: 1200, endMs: 2000,
    words: [["Second", 1200, 1500], ["one", 1500, 1700], ["now.", 1700, 2000]] },
];

describe("activeLineIndex", () => {
  const index = buildLineIndex(LINES);
  it("clamps to line 0 during lead-in silence before the first word", () => {
    expect(activeLineIndex(index, -50)).toBe(0);
  });
  it("finds the line whose span contains the playhead", () => {
    expect(activeLineIndex(index, 500)).toBe(0);
    expect(activeLineIndex(index, 1600)).toBe(1);
  });
  it("stays on the last started line during the inter-line gap", () => {
    expect(activeLineIndex(index, 1100)).toBe(0); // between line 0 end and line 1 start
  });
  it("returns -1 for an empty transcript", () => {
    expect(activeLineIndex(buildLineIndex([]), 0)).toBe(-1);
  });
});

describe("wordsStartedBy", () => {
  const words = LINES[0].words;
  it("counts words whose start has passed", () => {
    expect(wordsStartedBy(words, -1)).toBe(0);
    expect(wordsStartedBy(words, 0)).toBe(1);
    expect(wordsStartedBy(words, 350)).toBe(2);
    expect(wordsStartedBy(words, 700)).toBe(3);
    expect(wordsStartedBy(words, 5000)).toBe(3);
  });
});

describe("lineReveal", () => {
  it("reveals nothing before the first word", () => {
    expect(lineReveal(LINES[0], -10)).toMatchObject({ activeWord: -1, spokenCount: 0 });
  });
  it("tracks the active word and its progress mid-utterance", () => {
    const r = lineReveal(LINES[0], 500); // inside 'sentence' [300,700]
    expect(r.activeWord).toBe(1);
    expect(r.spokenCount).toBe(2);
    expect(r.wordProgress).toBeCloseTo(0.5, 2);
  });
  it("reveals the whole sentence once it is in the past", () => {
    const r = lineReveal(LINES[0], 2000);
    expect(r.activeWord).toBe(2);
    expect(r.spokenCount).toBe(3);
    expect(r.lineProgress).toBe(1);
  });
  it("falls back to whole-line progress when a line has no word timings", () => {
    const noWords = { startMs: 0, endMs: 1000, words: [] };
    expect(lineReveal(noWords, 500).lineProgress).toBeCloseTo(0.5, 2);
  });
});

describe("revealFromChars", () => {
  const text = "Rain hammered the stones."; // words at chars: Rain[0,4) hammered[5,13) the[14,17) stones.[18,25)
  it("reveals nothing before the first char", () => {
    expect(revealFromChars(text, 0)).toMatchObject({ activeWord: -1, spokenCount: 0 });
  });
  it("marks the straddled word active and prior words spoken", () => {
    const r = revealFromChars(text, 9); // inside 'hammered' [5,13)
    expect(r.activeWord).toBe(1);
    expect(r.spokenCount).toBe(1); // only 'Rain' fully spoken
    expect(r.wordProgress).toBeCloseTo((9 - 5) / 8, 2);
  });
  it("reveals the whole line once revealed >= length", () => {
    const r = revealFromChars(text, text.length);
    expect(r.activeWord).toBe(3);
    expect(r.spokenCount).toBe(4);
    expect(r.wordProgress).toBe(1);
  });
  it("splits words consistently for the render", () => {
    expect(revealFromChars(text, 25).words).toEqual(["Rain", "hammered", "the", "stones."]);
  });
  it("handles empty text", () => {
    expect(revealFromChars("", 5)).toMatchObject({ activeWord: -1, words: [] });
  });
});
