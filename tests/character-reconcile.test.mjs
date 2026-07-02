/**
 * character-reconcile — heuristic pass run right before a concurrently-
 * extracted chapter drains: rewrites placeholder character ids/names
 * ("unnamed male protagonist") to the canonical id of an already-known or
 * look-ahead-buffered real character when there's a plausible match (same
 * gender + role/description overlap), without any extra LLM call.
 * Run: npm run test:character-reconcile
 */
import assert from "node:assert";
import { isPlaceholderCharacter, reconcileChapterCharacters } from "../worker/_shared/character-reconcile.js";

function chapterWith(characters, sceneCharacterId) {
  return {
    chapterIndex: 3,
    characters,
    scenes: [{
      id: "scene-0001",
      present_character_ids: [sceneCharacterId],
      lines: [{ character_id: sceneCharacterId, text: "...", kind: "dialogue" }],
    }],
  };
}

// --- isPlaceholderCharacter ---
{
  assert.equal(isPlaceholderCharacter({ id: "unnamed-male-protagonist", name: "Unnamed male protagonist" }), true);
  assert.equal(isPlaceholderCharacter({ id: "unknown_woman", name: "Unknown woman" }), true);
  assert.equal(isPlaceholderCharacter({ id: "the-old-man", name: "The old man" }), true);
  assert.equal(isPlaceholderCharacter({ id: "eizo", name: "Eizo" }), false);
  assert.equal(isPlaceholderCharacter({ id: "samya", name: "Samya" }), false);
}

// --- matches a known (already-drained) character by gender + description overlap ---
{
  const placeholder = {
    id: "unnamed-male-protagonist", name: "Unnamed male protagonist",
    gender: "male", importance: "primary", description: "a stoic swordsman with a scarred face",
  };
  const analysis = chapterWith([placeholder], "unnamed-male-protagonist");
  const knownCharacters = [{
    id: "eizo", name: "Eizo", gender: "male", importance: "primary",
    description: "a stoic swordsman, scarred face, wields a katana",
  }];

  const out = reconcileChapterCharacters(analysis, { knownCharacters, lookaheadCharacters: [] });

  assert.equal(out.characters.length, 1);
  assert.equal(out.characters[0].id, "eizo", "placeholder character entry is remapped to the canonical id");
  assert.equal(out.scenes[0].present_character_ids[0], "eizo", "scene reference is remapped");
  assert.equal(out.scenes[0].lines[0].character_id, "eizo", "line reference is remapped");
}

// --- matches a look-ahead (undrained future chapter) character ---
{
  const placeholder = {
    id: "unnamed-male-protagonist", name: "Unnamed male protagonist",
    gender: "male", importance: "primary", description: "swordsman",
  };
  const analysis = chapterWith([placeholder], "unnamed-male-protagonist");
  const lookaheadCharacters = [{
    id: "eizo", name: "Eizo", gender: "male", importance: "primary", description: "swordsman, scarred",
  }];

  const out = reconcileChapterCharacters(analysis, { knownCharacters: [], lookaheadCharacters });
  assert.equal(out.characters[0].id, "eizo");
  assert.equal(out.scenes[0].lines[0].character_id, "eizo");
}

// --- no candidates at all: analysis passes through unchanged (same reference is fine, but content must be equal) ---
{
  const placeholder = { id: "unnamed-woman", name: "Unnamed woman", gender: "female" };
  const analysis = chapterWith([placeholder], "unnamed-woman");
  const out = reconcileChapterCharacters(analysis, { knownCharacters: [], lookaheadCharacters: [] });
  assert.equal(out.characters[0].id, "unnamed-woman", "no candidates to match against -> kept as-is");
}

// --- gender mismatch disqualifies a match even with strong description overlap ---
{
  const placeholder = {
    id: "unnamed-woman", name: "Unnamed woman", gender: "female", description: "stoic swordsman scarred face",
  };
  const analysis = chapterWith([placeholder], "unnamed-woman");
  const knownCharacters = [{
    id: "eizo", name: "Eizo", gender: "male", description: "stoic swordsman scarred face",
  }];
  const out = reconcileChapterCharacters(analysis, { knownCharacters, lookaheadCharacters: [] });
  assert.equal(out.characters[0].id, "unnamed-woman", "gender mismatch must not merge");
}

// --- ambiguous tie between two equally-plausible candidates: safe default is no merge ---
{
  const placeholder = {
    id: "unnamed-male-protagonist", name: "Unnamed male protagonist", gender: "male", importance: "primary",
  };
  const analysis = chapterWith([placeholder], "unnamed-male-protagonist");
  const knownCharacters = [
    { id: "eizo", name: "Eizo", gender: "male", importance: "primary" },
    { id: "kael", name: "Kael", gender: "male", importance: "primary" },
  ];
  const out = reconcileChapterCharacters(analysis, { knownCharacters, lookaheadCharacters: [] });
  assert.equal(out.characters[0].id, "unnamed-male-protagonist", "ambiguous match is left unmerged rather than guessed");
}

// --- an already-real-named character is left untouched even when plausible "matches" exist ---
{
  const real = { id: "samya", name: "Samya", gender: "female", importance: "secondary" };
  const analysis = chapterWith([real], "samya");
  const knownCharacters = [{ id: "mira", name: "Mira", gender: "female", importance: "secondary" }];
  const out = reconcileChapterCharacters(analysis, { knownCharacters, lookaheadCharacters: [] });
  assert.equal(out.characters[0].id, "samya", "non-placeholder characters are never rewritten");
}

// --- two distinct placeholders in the same chapter resolving to the same canonical id get deduped ---
{
  const p1 = { id: "unnamed-man-1", name: "Unnamed man", gender: "male", importance: "primary", description: "swordsman" };
  const p2 = { id: "unnamed-man-2", name: "The man", gender: "male", importance: "primary", description: "swordsman" };
  const analysis = {
    chapterIndex: 4,
    characters: [p1, p2],
    scenes: [{
      id: "scene-0001",
      present_character_ids: ["unnamed-man-1", "unnamed-man-2"],
      lines: [
        { character_id: "unnamed-man-1", text: "a", kind: "dialogue" },
        { character_id: "unnamed-man-2", text: "b", kind: "dialogue" },
      ],
    }],
  };
  const knownCharacters = [{
    id: "eizo", name: "Eizo", gender: "male", importance: "primary", description: "swordsman",
  }];
  const out = reconcileChapterCharacters(analysis, { knownCharacters, lookaheadCharacters: [] });
  const eizoEntries = out.characters.filter((c) => c.id === "eizo");
  assert.equal(eizoEntries.length, 1, "both placeholders collapse into a single deduped character entry");
  assert.equal(out.scenes[0].present_character_ids[0], "eizo");
  assert.equal(out.scenes[0].present_character_ids[1], "eizo");
  assert.equal(out.scenes[0].lines[0].character_id, "eizo");
  assert.equal(out.scenes[0].lines[1].character_id, "eizo");
}

console.log("character-reconcile: ok");
