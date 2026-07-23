/**
 * booknlp-script.js — shapes one chapter's BookNLP server output into the
 * exact chapterAnalysis contract compileChapterPlayback expects, so the
 * existing per-chapter finishChapter pipeline (repair -> attribute ->
 * compile -> persist) runs unchanged regardless of source.
 * Run: node tests/booknlp-script.test.mjs
 */
import assert from "node:assert";
import { buildBooknlpChapterAnalysis } from "../worker/_shared/booknlp-script.js";

const chapter = { index: 3, title: "Chapter 3: The Moss Gate" };

// Basic shaping: characters + scenes[0].lines + chapterIndex/chapterTitle,
// matching what extractChapterRaw's LLM path normally produces.
{
  const booknlpResult = {
    characters: [
      { id: "mira", name: "Mira", gender: "female", mention_count: 13, quote_count: 7, has_proper_name: true },
      { id: "orin", name: "Orin", gender: "unknown", mention_count: 5, quote_count: 4, has_proper_name: true },
    ],
    lines: [
      { kind: "narration", text: "Rain had stopped by the time Mira and Orin reached the moss gate." },
      { kind: "dialogue", text: "The wards still hum,", character_id: "mira" },
      { kind: "narration", text: "she said." },
    ],
    meta: { character_count: 2, quote_count: 1, low_confidence_count: 0 },
  };

  const analysis = buildBooknlpChapterAnalysis(booknlpResult, chapter);

  assert.equal(analysis.chapterIndex, 3);
  assert.equal(analysis.chapterTitle, "Chapter 3: The Moss Gate");
  assert.equal(analysis.characters.length, 2);
  assert.deepEqual(analysis.characters.map((c) => c.id), ["mira", "orin"]);
  assert.equal(analysis.characters[0].name, "Mira");
  assert.equal(analysis.characters[0].gender, "female");
  assert.equal(analysis.characters[0].importance, "secondary");

  assert.equal(analysis.scenes.length, 1);
  const scene = analysis.scenes[0];
  assert.equal(scene.chapter, 3);
  assert.equal(scene.title, "Chapter 3: The Moss Gate");
  assert.deepEqual(scene.present_character_ids, ["mira", "orin"]);
  assert.equal(scene.lines.length, 3);
}

// Every line is verbatim text + attribution_source:"booknlp"; narration
// lines carry no character_id (compileChapterPlayback defaults that to
// "narrator" itself), dialogue lines carry the resolved character_id.
{
  const booknlpResult = {
    characters: [{ id: "orin", name: "Orin", gender: "unknown" }],
    lines: [
      { kind: "narration", text: "Orin rested a hand on his sword hilt." },
      { kind: "dialogue", text: "Keep your voice down.", character_id: "orin" },
    ],
    meta: {},
  };
  const analysis = buildBooknlpChapterAnalysis(booknlpResult, chapter);
  const [narrationLine, dialogueLine] = analysis.scenes[0].lines;

  assert.equal(narrationLine.kind, "narration");
  assert.equal(narrationLine.text, "Orin rested a hand on his sword hilt.");
  assert.equal(narrationLine.character_id, undefined, "narration line carries no character_id");
  assert.equal(narrationLine.attribution_source, "booknlp");

  assert.equal(dialogueLine.kind, "dialogue");
  assert.equal(dialogueLine.character_id, "orin");
  assert.equal(dialogueLine.attribution_source, "booknlp");
}

// Low-confidence flags carried through only when the source line set them —
// a confidently-attributed line has neither field, not false/null placeholders.
{
  const booknlpResult = {
    characters: [{ id: "unnamed-9", name: "Unnamed Character 9", gender: "unknown" }],
    lines: [
      {
        kind: "dialogue", text: "Wait!", character_id: "unnamed-9",
        low_confidence_speaker: true, confidence_reason: "singleton",
      },
      { kind: "dialogue", text: "Understood.", character_id: "orin" },
    ],
    meta: {},
  };
  const analysis = buildBooknlpChapterAnalysis(booknlpResult, chapter);
  const [lowConfLine, confidentLine] = analysis.scenes[0].lines;

  assert.equal(lowConfLine.low_confidence_speaker, true);
  assert.equal(lowConfLine.confidence_reason, "singleton");

  assert.equal(confidentLine.low_confidence_speaker, undefined);
  assert.equal(confidentLine.confidence_reason, undefined);
}

// A chapter with zero dialogue (pure narration) still shapes cleanly —
// empty characters/present_character_ids, one scene of narration-only lines.
{
  const booknlpResult = {
    characters: [],
    lines: [{ kind: "narration", text: "Nothing happened for a while." }],
    meta: { character_count: 0, quote_count: 0, low_confidence_count: 0 },
  };
  const analysis = buildBooknlpChapterAnalysis(booknlpResult, chapter);
  assert.deepEqual(analysis.characters, []);
  assert.deepEqual(analysis.scenes[0].present_character_ids, []);
  assert.equal(analysis.scenes[0].lines.length, 1);
}

// Chapter with no title falls back to empty string (not "undefined") and the
// scene title falls back to "Chapter N".
{
  const analysis = buildBooknlpChapterAnalysis(
    { characters: [], lines: [], meta: {} },
    { index: 7, title: "" },
  );
  assert.equal(analysis.chapterTitle, "");
  assert.equal(analysis.scenes[0].title, "Chapter 7");
}

console.log("booknlp-script.test.mjs: ok");
