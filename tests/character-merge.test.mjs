/**
 * character-merge — user-driven identity fixes: merge a misidentified
 * character (e.g. "unnamed-male-protagonist") into an existing one, rename
 * one in place, and propagate a confirmed merge to future-extracted chapters
 * via applyCharacterAliases. Run: npm run test:character-merge
 */
import assert from "node:assert";
import {
  mergeCharacterInAnalysis, mergeCharacterInPlayback, renameCharacterInAnalysis, renameCharacterInPlayback,
  applyCharacterAliases,
} from "../worker/_shared/character-merge.js";

// --- mergeCharacterInAnalysis: characters + scene refs remapped, target wins on identity ---
{
  const analysis = {
    characters: [
      { id: "unnamed-male-protagonist", name: "Unnamed male protagonist", gender: "male", description: "a stoic swordsman" },
      { id: "eizo", name: "Eizo", gender: "male", description: "scarred face" },
    ],
    scenes: [{
      present_character_ids: ["unnamed-male-protagonist"],
      lines: [{ character_id: "unnamed-male-protagonist", text: "..." }, { character_id: "eizo", text: "!" }],
    }],
  };
  const out = mergeCharacterInAnalysis(analysis, "unnamed-male-protagonist", "eizo");

  assert.equal(out.characters.length, 1, "placeholder entry removed, only target remains");
  assert.equal(out.characters[0].id, "eizo");
  assert.equal(out.characters[0].description, "a stoic swordsman", "longer description wins");
  assert.ok(out.characters[0].aliases.includes("Unnamed male protagonist"), "old name kept as alias");
  assert.deepEqual(out.scenes[0].present_character_ids, ["eizo"]);
  assert.equal(out.scenes[0].lines[0].character_id, "eizo");
  assert.equal(out.scenes[0].lines[1].character_id, "eizo");
}

// --- mergeCharacterInPlayback: baked speaker_name/voice/sprite all switch to target's ---
{
  const playback = {
    characters: {
      "unnamed-male-protagonist": {
        name: "Unnamed male protagonist", sprite: "sprite:gradient:1,2", voice: "en-US-GuyNeural", pitch: "+0Hz", rate: "+0%",
      },
      eizo: {
        name: "Eizo", sprite: "sprite:gradient:9,9", voice: "en-US-DavisNeural", pitch: "+10Hz", rate: "+5%", importance: "primary",
      },
    },
    scenes: [{
      present: [{ character_id: "unnamed-male-protagonist", name: "Unnamed male protagonist", sprite: "sprite:gradient:1,2" }],
      lines: [{
        character_id: "unnamed-male-protagonist", speaker_name: "Unnamed male protagonist", voice: "en-US-GuyNeural", text: "...",
      }],
    }],
  };
  const out = mergeCharacterInPlayback(playback, "unnamed-male-protagonist", "eizo");

  assert.equal(out.characters["unnamed-male-protagonist"], undefined, "merged id dropped from roster");
  assert.equal(Object.keys(out.characters).length, 1);
  assert.equal(out.scenes[0].present[0].character_id, "eizo");
  assert.equal(out.scenes[0].present[0].sprite, "sprite:gradient:9,9", "sprite now matches target");
  assert.equal(out.scenes[0].lines[0].character_id, "eizo");
  assert.equal(out.scenes[0].lines[0].speaker_name, "Eizo");
  assert.equal(out.scenes[0].lines[0].voice, "en-US-DavisNeural", "voice now matches target");
}

// --- rename: display name updates everywhere it was baked into playback lines ---
{
  const playback = {
    characters: { eizo: { name: "Eizo", sprite: "sprite:x", voice: "v" } },
    scenes: [{
      present: [{ character_id: "eizo", name: "Eizo" }],
      lines: [{ character_id: "eizo", speaker_name: "Eizo", text: "hi" }],
    }],
  };
  const out = renameCharacterInPlayback(playback, "eizo", "Eizo Kagari");
  assert.equal(out.characters.eizo.name, "Eizo Kagari");
  assert.equal(out.scenes[0].present[0].name, "Eizo Kagari");
  assert.equal(out.scenes[0].lines[0].speaker_name, "Eizo Kagari");
}

{
  const analysis = { characters: [{ id: "eizo", name: "Eizo" }] };
  const out = renameCharacterInAnalysis(analysis, "eizo", "Eizo Kagari");
  assert.equal(out.characters[0].name, "Eizo Kagari");
}

// --- applyCharacterAliases: a future chapter re-introducing the placeholder id lands on the canonical one ---
{
  const chapterAnalysis = {
    characters: [{ id: "unnamed-male-protagonist", name: "Unnamed male protagonist" }],
    scenes: [{
      present_character_ids: ["unnamed-male-protagonist"],
      lines: [{ character_id: "unnamed-male-protagonist", text: "..." }],
    }],
  };
  const out = applyCharacterAliases(chapterAnalysis, { "unnamed-male-protagonist": "eizo" });
  assert.equal(out.characters[0].id, "eizo");
  assert.ok(out.characters[0].aliases.includes("Unnamed male protagonist"));
  assert.equal(out.scenes[0].present_character_ids[0], "eizo");
  assert.equal(out.scenes[0].lines[0].character_id, "eizo");
}

// --- applyCharacterAliases: transitive chain (a->b->c) resolves to the final target ---
{
  const chapterAnalysis = { characters: [{ id: "a", name: "A" }], scenes: [] };
  const out = applyCharacterAliases(chapterAnalysis, { a: "b", b: "c" });
  assert.equal(out.characters[0].id, "c");
}

// --- applyCharacterAliases: no matching alias -> passthrough unchanged ---
{
  const chapterAnalysis = { characters: [{ id: "eizo", name: "Eizo" }], scenes: [] };
  const out = applyCharacterAliases(chapterAnalysis, { "unnamed-male-protagonist": "eizo" });
  assert.equal(out.characters[0].id, "eizo");
}

// --- applyCharacterAliases: two chapter characters aliasing to the same canonical id get deduped ---
{
  const chapterAnalysis = {
    characters: [
      { id: "unnamed-male-protagonist", name: "Unnamed male protagonist" },
      { id: "the-swordsman", name: "The swordsman" },
    ],
    scenes: [],
  };
  const out = applyCharacterAliases(chapterAnalysis, { "unnamed-male-protagonist": "eizo", "the-swordsman": "eizo" });
  assert.equal(out.characters.length, 1);
  assert.equal(out.characters[0].id, "eizo");
}

console.log("character-merge: all assertions passed");
