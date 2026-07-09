/**
 * Unit tests — compileChapterPlayback/compilePlayback synthesize a
 * placeholder entry for any character id referenced in
 * present_character_ids/line.character_id but never declared in the
 * extraction's own `characters[]` array. Regression for a real bug:
 * confirmed on a real extracted book that the series protagonist ("eizo")
 * was referenced throughout scenes/dialogue but never declared, which meant
 * every line he spoke got misattributed to the Narrator (wrong name, wrong
 * voice) and he never appeared in the top-level characters map at all — so
 * he was invisible to the art-gen menu / CharacterManager despite rendering
 * fine on stage (scene.present had its own separate, more forgiving
 * fallback that masked the problem there).
 * Run: node tests/undeclared-character-synthesis.test.mjs
 */
import assert from "node:assert";
import { compileChapterPlayback, compilePlayback } from "../worker/_shared/compile-playback.js";

// compileChapterPlayback — undeclared character gets a real name/voice on
// their lines, and lands in the compiled characters map.
{
  const chapterAnalysis = {
    chapterIndex: 1,
    characters: [{ id: "kuro", name: "Kuro", importance: "primary", gender: "male" }],
    scenes: [
      {
        id: "s1",
        chapter: 1,
        present_character_ids: ["kuro", "eizo"],
        lines: [
          { character_id: "eizo", text: "Hello.", kind: "dialogue" },
          { character_id: "kuro", text: "Hey.", kind: "dialogue" },
        ],
      },
    ],
  };
  const { scenes, newCharactersOut } = compileChapterPlayback(chapterAnalysis, {
    narrator_gender: "male",
    voiceState: { assignments: {}, usedCounts: {} },
    knownCharacters: {},
    startingLineIdx: 0,
  });

  assert.ok(newCharactersOut.eizo, "undeclared character gets synthesized into the characters map");
  assert.equal(newCharactersOut.eizo.name, "Eizo", "synthesized name derived from the id");

  const eizoLine = scenes[0].lines.find((l) => l.character_id === "eizo");
  assert.equal(eizoLine.speaker_name, "Eizo", "line no longer misattributed to Narrator");
  assert.equal(eizoLine.kind, "dialogue", "not silently reclassified as narration");
  assert.equal(eizoLine.voice, newCharactersOut.eizo.voice, "gets its own assigned voice");

  const presentEntry = scenes[0].present.find((p) => p.character_id === "eizo");
  assert.equal(presentEntry.name, "Eizo");
}

// compilePlayback (legacy whole-book path) — same guarantee.
{
  const analysis = {
    book_id: "b1",
    title: "T",
    characters: [{ id: "kuro", name: "Kuro", importance: "primary", gender: "male" }],
    scenes: [
      {
        id: "s1",
        chapter: 1,
        present_character_ids: ["kuro", "eizo"],
        lines: [{ character_id: "eizo", text: "Hello.", kind: "dialogue" }],
      },
    ],
  };
  const playback = compilePlayback(analysis, { narrator_gender: "male" });
  assert.ok(playback.characters.eizo, "undeclared character present in legacy compile too");
  assert.equal(playback.scenes[0].lines[0].speaker_name, "Eizo");
}

// A character who genuinely never appears anywhere isn't synthesized —
// this only fires for ids actually referenced in scenes/lines.
{
  const chapterAnalysis = {
    chapterIndex: 1,
    characters: [{ id: "kuro", name: "Kuro" }],
    scenes: [{ id: "s1", chapter: 1, present_character_ids: ["kuro"], lines: [] }],
  };
  const { newCharactersOut } = compileChapterPlayback(chapterAnalysis, {
    voiceState: { assignments: {}, usedCounts: {} },
    knownCharacters: {},
  });
  assert.equal(Object.keys(newCharactersOut).length, 1, "only kuro — nothing spurious synthesized");
}

console.log("undeclared-character-synthesis.test.mjs: ok");
