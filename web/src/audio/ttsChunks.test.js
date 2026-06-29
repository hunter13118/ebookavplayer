import { describe, expect, it } from "vitest";
import {
  splitTextChunks,
  buildSpeechUnits,
  TTS_CHUNK_MAX_CHARS,
} from "./ttsChunks.js";

describe("ttsChunks", () => {
  it("keeps short text as one chunk", () => {
    expect(splitTextChunks("Hello world.")).toEqual(["Hello world."]);
  });

  it("splits long text on punctuation when available", () => {
    const sentence = "This is a longer sentence with enough words to matter for the test.";
    const para = Array.from({ length: 8 }, () => sentence).join(" ");
    const parts = splitTextChunks(para);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts.slice(0, -1)) {
      expect(p.length).toBeLessThanOrEqual(TTS_CHUNK_MAX_CHARS + 5);
      expect(p.trim()).toMatch(/[.!?…]["'\u201d\u2019)]*$/);
    }
  });

  it("falls back to word split when window has no punctuation", () => {
    const long = "alpha ".repeat(45).trim();
    const parts = splitTextChunks(long);
    expect(parts.length).toBeGreaterThan(1);
  });

  it("builds units with stable char offsets", () => {
    const text = `${"alpha ".repeat(45).trim()} beta.`;
    const line = { text, character_id: "narrator" };
    const units = buildSpeechUnits([line], 0);
    expect(units.length).toBeGreaterThan(1);
    expect(units[0].charStart).toBe(0);
    expect(units[units.length - 1].charEnd).toBe(text.length);
    for (const u of units) {
      expect(text.slice(u.charStart, u.charEnd)).toBe(u.text);
    }
  });
});
