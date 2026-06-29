import {
  splitTextChunks,
  normalizePlaybackLines,
  findPunctuationSplit,
  findWordSplit,
  PLAYBACK_LINE_MAX_CHARS,
} from "../worker/_shared/line-chunk.js";

const long = "word ".repeat(50).trim() + " end.";
const parts = splitTextChunks(long);
if (parts.length < 2) throw new Error("expected multiple chunks");
for (const p of parts) {
  if (p.length > PLAYBACK_LINE_MAX_CHARS + 20) {
    throw new Error(`chunk too long: ${p.length}`);
  }
}

const noPunct = "alpha ".repeat(45).trim();
if (findPunctuationSplit(noPunct.slice(0, PLAYBACK_LINE_MAX_CHARS)) !== -1) {
  throw new Error("should not find punctuation in no-punct window");
}
const wordSplit = findWordSplit(noPunct.slice(0, PLAYBACK_LINE_MAX_CHARS), PLAYBACK_LINE_MAX_CHARS);
if (wordSplit <= 0) throw new Error("expected word split");

const para = [
  "The rooftop was locked.",
  "Everyone said so.",
  "She stepped into the wind anyway.",
  "The sky was peach and violet.",
  "The city below looked dipped in honey.",
  "Mei leaned on the railing.",
  "A vending machine hummed in the corner.",
  "It had not been there a moment ago.",
].join(" ");

const sentParts = splitTextChunks(para);
for (const p of sentParts) {
  if (p.length > PLAYBACK_LINE_MAX_CHARS) throw new Error(`sentence chunk too long: ${p.length}`);
}
const endsWell = sentParts.filter((p) => /[.!?…]["'\u201d\u2019)]*$/.test(p.trim()));
if (endsWell.length < sentParts.length - 1) {
  throw new Error(`expected punctuation splits, got: ${JSON.stringify(sentParts)}`);
}

const sample = {
  book_id: "test",
  scenes: [{
    id: "s1",
    lines: [{ idx: 0, text: long, character_id: "narrator", kind: "narration" }],
  }],
};

const { playback, changed } = normalizePlaybackLines(sample);
if (!changed) throw new Error("expected changed");
if (playback.scenes[0].lines.length < 2) throw new Error("expected split lines");

console.log("line-chunk tests ok");
