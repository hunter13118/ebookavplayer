import { describe, it, expect } from "vitest";
import {
  groupIntoParagraphs, paragraphTokens, paragraphIndexOfLine, gapInsertIndex,
} from "./paragraphs.js";

function narr(text) { return { kind: "narration", character_id: "narrator", text }; }
function say(character_id, text) { return { kind: "dialogue", character_id, text }; }

describe("groupIntoParagraphs", () => {
  it("merges a run of consecutive narration sentences into one paragraph", () => {
    const lines = [
      narr("Within the heart of the empire’s palace was a room, one lacking a throne."),
      narr("This was one of the emperor’s several parlors."),
      narr("At the moment, the room’s master was wearing a smile."),
    ];
    const paras = groupIntoParagraphs(lines);
    expect(paras).toHaveLength(1);
    expect(paras[0]).toMatchObject({ startLine: 0, endLine: 3 });
    expect(paras[0].text).toBe(
      "Within the heart of the empire’s palace was a room, one lacking a throne. "
      + "This was one of the emperor’s several parlors. "
      + "At the moment, the room’s master was wearing a smile.",
    );
  });

  it("starts a fresh paragraph when narration is followed by a new dialogue line", () => {
    const lines = [
      narr("At the moment, the room’s master was wearing a smile."),
      say("anne", "Did Your Majesty say the Black Forest?"),
    ];
    const paras = groupIntoParagraphs(lines);
    expect(paras).toHaveLength(2);
    expect(paras[0]).toMatchObject({ startLine: 0, endLine: 1 });
    expect(paras[1]).toMatchObject({ startLine: 1, endLine: 2 });
  });

  it("keeps a dialogue line and its short attribution tag in ONE paragraph, quote-wrapped", () => {
    const lines = [
      say("anne", "Did Your Majesty say the Black Forest?"),
      narr("the princess asked, her tone dubious."),
    ];
    const paras = groupIntoParagraphs(lines);
    expect(paras).toHaveLength(1);
    expect(paras[0].text).toBe(
      "“Did Your Majesty say the Black Forest?” the princess asked, her tone dubious.",
    );
  });

  it("starts a new paragraph for a long narration passage after dialogue (not a tag)", () => {
    const lines = [
      say("emperor", "A most interesting man, no?"),
      narr(
        "In response to her father’s cheery delivery of an outrageous statement, "
        + "she could only muster a feeble,",
      ),
      say("anne", "I see."),
    ];
    const paras = groupIntoParagraphs(lines);
    // Long narration (>12 words) after dialogue is NOT a tag -> new paragraph.
    // But it trails into the next quote via an open (comma) ending -> merges forward.
    expect(paras).toHaveLength(2);
    expect(paras[0]).toMatchObject({ startLine: 0, endLine: 1 });
    expect(paras[1]).toMatchObject({ startLine: 1, endLine: 3 });
    expect(paras[1].text).toContain("“I see.”");
  });

  it("never breaks mid-sentence, regardless of speaker/kind, when the prior line ends open", () => {
    const lines = [
      narr("She turned to him and said,"),
      say("emperor", "Indeed."),
    ];
    const paras = groupIntoParagraphs(lines);
    expect(paras).toHaveLength(1);
    expect(paras[0].text).toBe("She turned to him and said, “Indeed.”");
  });

  it("merges consecutive dialogue by the SAME speaker into one quote span", () => {
    const lines = [
      say("emperor", "Well now."),
      say("emperor", "That is quite the tale."),
    ];
    const paras = groupIntoParagraphs(lines);
    expect(paras).toHaveLength(1);
    expect(paras[0].text).toBe("“Well now. That is quite the tale.”");
  });

  it("splits consecutive dialogue by DIFFERENT speakers into separate paragraphs", () => {
    const lines = [
      say("emperor", "Indeed."),
      say("anne", "I see."),
    ];
    const paras = groupIntoParagraphs(lines);
    expect(paras).toHaveLength(2);
  });

  it("forces a paragraph break on a scene change even mid-run", () => {
    const lines = [narr("First scene line one."), narr("First scene line two."), narr("Second scene starts.")];
    const sceneOf = [0, 0, 1];
    const paras = groupIntoParagraphs(lines, sceneOf);
    expect(paras).toHaveLength(2);
    expect(paras[0]).toMatchObject({ startLine: 0, endLine: 2 });
    expect(paras[1]).toMatchObject({ startLine: 2, endLine: 3 });
  });

  it("treats lines with no kind (raw transcript) as narration and keeps flowing", () => {
    const lines = [{ text: "One." }, { text: "Two." }, { text: "Three." }];
    const paras = groupIntoParagraphs(lines);
    expect(paras).toHaveLength(1);
    expect(paras[0].text).toBe("One. Two. Three.");
  });

  it("handles an empty book", () => {
    expect(groupIntoParagraphs([])).toEqual([]);
  });

  it("covers every line exactly once, contiguously, with no gaps", () => {
    const lines = [
      narr("A."), narr("B."), say("x", "C?"), narr("said x."), say("y", "D."), narr("E."),
    ];
    const paras = groupIntoParagraphs(lines);
    expect(paras[0].startLine).toBe(0);
    for (let i = 1; i < paras.length; i++) expect(paras[i].startLine).toBe(paras[i - 1].endLine);
    expect(paras[paras.length - 1].endLine).toBe(lines.length);
  });
});

describe("paragraphIndexOfLine", () => {
  const paras = [{ startLine: 0, endLine: 3 }, { startLine: 3, endLine: 5 }, { startLine: 5, endLine: 6 }];
  it("finds the paragraph containing a line", () => {
    expect(paragraphIndexOfLine(paras, 0)).toBe(0);
    expect(paragraphIndexOfLine(paras, 2)).toBe(0);
    expect(paragraphIndexOfLine(paras, 3)).toBe(1);
    expect(paragraphIndexOfLine(paras, 5)).toBe(2);
  });
  it("clamps out-of-range to the last paragraph", () => {
    expect(paragraphIndexOfLine(paras, 99)).toBe(2);
  });
  it("returns 0 for an empty paragraph list", () => {
    expect(paragraphIndexOfLine([], 4)).toBe(0);
  });
});

describe("paragraphTokens", () => {
  it("tags each word with its originating line index", () => {
    const lines = [
      say("anne", "Did Your Majesty say the Black Forest?"),
      narr("the princess asked, her tone dubious."),
    ];
    const tokens = paragraphTokens(lines, 0, 2);
    expect(tokens[0]).toMatchObject({ lineIdx: 0 });
    expect(tokens[0].text).toBe("“Did");
    const lastQuoteWordIdx = tokens.findIndex((t) => t.text.includes("Forest?”"));
    expect(lastQuoteWordIdx).toBeGreaterThan(0);
    expect(tokens.at(-1)).toMatchObject({ lineIdx: 1 });
    // Every word of line 0 precedes every word of line 1, in order.
    const line0Count = tokens.filter((t) => t.lineIdx === 0).length;
    expect(line0Count).toBe(7); // "Did Your Majesty say the Black Forest?"
  });

  it("merges a same-speaker quote run into tokens spanning both lines, quoted once", () => {
    const lines = [say("emperor", "Well now."), say("emperor", "That is quite the tale.")];
    const tokens = paragraphTokens(lines, 0, 2);
    expect(tokens[0].text).toBe("“Well");
    expect(tokens.at(-1).text).toBe("tale.”");
    expect(tokens.filter((t) => t.text.includes("“") || t.text.includes("”"))).toHaveLength(2);
  });
});

describe("groupIntoParagraphs — long-narration-run cap", () => {
  it("forces a break once accumulated narration text passes MAX_PARAGRAPH_CHARS, even with no dialogue/scene change", () => {
    // 30 pure-narration sentences (~30 chars each, ~900 chars total) — nothing
    // else would ever break this up (narration -> narration never breaks in
    // shouldBreak()), so without a cap this stays ONE paragraph forever, no
    // matter how long the book's narration run gets.
    const lines = Array.from({ length: 30 }, (_, i) => narr(`This is sentence number ${i} right here.`));
    const paras = groupIntoParagraphs(lines);
    expect(paras.length).toBeGreaterThan(1);
    // Never split mid-sentence — every paragraph boundary lands exactly on a
    // real line boundary, and every line is accounted for exactly once.
    expect(paras[0].startLine).toBe(0);
    expect(paras.at(-1).endLine).toBe(lines.length);
    for (let i = 1; i < paras.length; i++) expect(paras[i].startLine).toBe(paras[i - 1].endLine);
    // Each capped paragraph's text stays reasonably close to the cap, not
    // ballooning back up to the full 900+ chars.
    for (const p of paras) expect(p.text.length).toBeLessThan(500);
  });

  it("still merges a short run of narration into one paragraph, unaffected by the cap", () => {
    const lines = [
      narr("Within the heart of the empire’s palace was a room, one lacking a throne."),
      narr("This was one of the emperor’s several parlors."),
      narr("At the moment, the room’s master was wearing a smile."),
    ];
    expect(groupIntoParagraphs(lines)).toHaveLength(1);
  });
});

describe("gapInsertIndex", () => {
  it("splices a leading gap BEFORE the pinned paragraph (e.g. a book's opening publisher bumper)", () => {
    expect(gapInsertIndex(0, true)).toBe(0);
  });

  it("splices a non-leading (mid-book) gap AFTER the pinned paragraph, as before", () => {
    expect(gapInsertIndex(0, false)).toBe(1);
  });

  it("works at a non-zero pinned paragraph too", () => {
    expect(gapInsertIndex(3, true)).toBe(3);
    expect(gapInsertIndex(3, false)).toBe(4);
  });
});
