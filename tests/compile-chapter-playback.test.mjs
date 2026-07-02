/**
 * compileChapterPlayback — per-chapter incremental compilation used by the
 * checkpointed extraction pipeline. Covers: scene id uniqueness across
 * chapters (each chapter is compiled from an independently-extracted chunk,
 * so the model reliably reproduces the same "scene-0001"-style id from the
 * schema hint's example for every chapter — a real collision bug found via
 * live testing, fixed by always qualifying with the chapter number),
 * continuous line indices, and stable incremental voice assignment.
 * Run: npm run test:compile-chapter-playback
 */
import assert from "node:assert";
import { compileChapterPlayback } from "../worker/_shared/compile-playback.js";

function chapterAnalysis(chapterIndex, characterId, characterName, sceneId = "scene-0001") {
  return {
    chapterIndex,
    characters: [{ id: characterId, name: characterName, gender: "female", importance: "secondary" }],
    scenes: [{
      id: sceneId,
      chapter: chapterIndex,
      present_character_ids: [characterId],
      lines: [{ character_id: characterId, text: "Hello.", kind: "dialogue" }],
    }],
  };
}

// Two chapters, both with the model reproducing the literal schema-hint
// example id "scene-0001" — must not collide in the final playback.
{
  const ch1 = compileChapterPlayback(chapterAnalysis(1, "eizo", "Eizo"), {
    art_style: "anime", narrator_gender: "male", voiceState: undefined, knownCharacters: {}, startingLineIdx: 0,
  });
  const ch2 = compileChapterPlayback(chapterAnalysis(2, "samya", "Samya"), {
    art_style: "anime", narrator_gender: "male",
    voiceState: ch1.updatedVoiceState, knownCharacters: {}, startingLineIdx: ch1.nextLineIdx,
  });

  assert.notEqual(ch1.scenes[0].id, ch2.scenes[0].id, "scene ids must be globally unique across chapters");
  assert.equal(ch2.scenes[0].lines[0].idx, ch1.nextLineIdx, "line index continues across chapters, no reset/gap");
}

// A character re-mentioned in a later chapter keeps their original voice —
// no re-sorting/reassignment as the roster grows.
{
  const ch1 = compileChapterPlayback(chapterAnalysis(1, "eizo", "Eizo"), {
    art_style: "anime", narrator_gender: "male", voiceState: undefined, knownCharacters: {}, startingLineIdx: 0,
  });
  const knownCharacters = { eizo: ch1.newCharactersOut.eizo };
  const ch2 = compileChapterPlayback({
    chapterIndex: 2,
    characters: [{ id: "eizo", name: "Eizo", gender: "female", importance: "secondary" }],
    scenes: [{
      id: "scene-0001", chapter: 2, present_character_ids: ["eizo"],
      lines: [{ character_id: "eizo", text: "Still here.", kind: "dialogue" }],
    }],
  }, {
    art_style: "anime", narrator_gender: "male",
    voiceState: ch1.updatedVoiceState, knownCharacters, startingLineIdx: ch1.nextLineIdx,
  });

  assert.equal(ch2.scenes[0].lines[0].voice, ch1.newCharactersOut.eizo.voice, "voice stays stable across chapters");
  assert.equal(Object.keys(ch2.newCharactersOut).length, 0, "an already-known character is not re-emitted as new");
}

console.log("compile-chapter-playback: ok");
