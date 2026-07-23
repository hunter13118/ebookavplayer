/**
 * booknlp-consolidate.js — culls a noisy BookNLP roster (~200 one-off/unnamed
 * "characters") down to the cast that actually carries the book, reassigning
 * dropped speakers' lines to the narrator so the roster stays culled through
 * playback re-compiles.
 * Run: node tests/booknlp-consolidate.test.mjs
 */
import assert from "node:assert";
import {
  consolidateCharacters, keepCharacterIds, DEFAULT_CONSOLIDATE_OPTS,
} from "../worker/_shared/booknlp-consolidate.js";

// Build a scenes array with N lines for a given character_id.
function linesFor(id, n, kind = "dialogue") {
  return Array.from({ length: n }, (_, i) => ({ character_id: id, kind, text: `${id} line ${i}` }));
}

// ── Keep the cast, drop the noise ────────────────────────────────────────────
// Mirrors the real book that motivated this: a named lead (Sylphy), a
// high-volume UNNAMED protagonist BookNLP never named (must be kept), plus
// singleton/low-count noise (a stray name and an unnamed one-off).
{
  const scenes = [{
    lines: [
      ...linesFor("narrator", 50, "narration"),
      ...linesFor("sylphy", 20),
      ...linesFor("unnamed-0", 30),   // anonymous but clearly a real speaker
      ...linesFor("orin", 1),         // named singleton — below the named bar
      ...linesFor("unnamed-143", 1),  // one-off unnamed noise
      ...linesFor("reg", 2),          // named, 2 lines — clears the named bar
    ],
  }];
  const characters = {
    narrator: { name: "Narrator" },
    sylphy: { name: "Sylphy" },
    "unnamed-0": { name: "Unnamed Character 0" },
    orin: { name: "Orin" },
    "unnamed-143": { name: "Unnamed Character 143" },
    reg: { name: "Reg" },
  };

  const { characters: kept, scenes: out, keptIds, droppedIds } = consolidateCharacters(characters, scenes);

  // narrator (always), sylphy (named>=2), unnamed-0 (unnamed>=6), reg (named>=2) survive.
  assert.deepEqual(new Set(Object.keys(kept)), new Set(["narrator", "sylphy", "unnamed-0", "reg"]));
  // "orin" (1 line, named<2) and "unnamed-143" (1 line, unnamed<6) are dropped.
  assert.deepEqual(new Set(droppedIds), new Set(["orin", "unnamed-143"]));
  assert.ok(keptIds.includes("unnamed-0"), "high-volume unnamed protagonist must survive");

  // Dropped speakers' lines are reassigned to narration, text preserved.
  const flat = out[0].lines;
  const orinLine = flat.find((l) => l.text === "orin line 0");
  assert.equal(orinLine.character_id, "narrator");
  assert.equal(orinLine.kind, "narration");
  assert.equal(orinLine.text, "orin line 0", "text is never rewritten");
  // Kept speakers untouched.
  assert.ok(flat.some((l) => l.character_id === "sylphy" && l.kind === "dialogue"));
  assert.ok(flat.some((l) => l.character_id === "unnamed-0" && l.kind === "dialogue"));
}

// ── Interjections mis-tagged as names are always dropped ─────────────────────
// BookNLP labels "Ahh," / "Boom!" as PROPER NAMES; they recur enough to clear
// the line-count bar, so they must be culled by name, not just by count.
{
  const scenes = [{
    lines: [
      ...linesFor("ahh", 10),   // clears named bar on count, but it's noise
      ...linesFor("boom", 5),
      ...linesFor("everyone", 8),
      ...linesFor("sylphy", 3),
    ],
  }];
  const { characters } = consolidateCharacters(
    { ahh: {}, boom: {}, everyone: {}, sylphy: {} }, scenes,
  );
  assert.deepEqual(Object.keys(characters), ["sylphy"], "only the real name survives");
}

// ── Unnamed bar is higher than named bar ─────────────────────────────────────
{
  const scenes = [{
    lines: [
      ...linesFor("named-guy", 3),    // named, 3 >= namedMin(2) -> keep
      ...linesFor("unnamed-9", 3),    // unnamed, 3 < unnamedMin(6) -> drop
    ],
  }];
  const keep = keepCharacterIds(scenes, { "named-guy": {}, "unnamed-9": {} });
  assert.ok(keep.has("named-guy"));
  assert.ok(!keep.has("unnamed-9"));
  assert.equal(DEFAULT_CONSOLIDATE_OPTS.unnamedMinLines > DEFAULT_CONSOLIDATE_OPTS.namedMinLines, true);
}

// ── narrator is always kept even with zero lines ─────────────────────────────
{
  const keep = keepCharacterIds([], { narrator: { name: "Narrator" } });
  assert.ok(keep.has("narrator"));
}

// ── Shared keep-set drives multiple views identically ────────────────────────
// The pipeline consolidates the analysis roster (array) and the playback
// roster (object map) with one keep-set so their casts match exactly.
{
  const analysisScenes = [{ lines: [...linesFor("mira", 5), ...linesFor("orin", 1)] }];
  const analysisChars = [{ id: "mira", name: "Mira" }, { id: "orin", name: "Orin" }, { id: "narrator", name: "Narrator" }];
  const first = consolidateCharacters(analysisChars, analysisScenes);
  const keepIds = new Set(first.keptIds);

  const playbackScenes = [{ lines: [...linesFor("mira", 5), ...linesFor("orin", 1)] }];
  const playbackChars = { mira: { name: "Mira" }, orin: { name: "Orin" }, narrator: { name: "Narrator" } };
  const second = consolidateCharacters(playbackChars, playbackScenes, { keepIds });

  assert.deepEqual(
    new Set(first.characters.map((c) => c.id)),
    new Set(Object.keys(second.characters)),
    "analysis (array) and playback (map) rosters must match",
  );
  assert.ok(!Object.keys(second.characters).includes("orin"), "orin (1 line) dropped from both");
}

// ── Custom thresholds ────────────────────────────────────────────────────────
{
  const scenes = [{ lines: [...linesFor("a", 4), ...linesFor("b", 10)] }];
  const keep = keepCharacterIds(scenes, { a: {}, b: {} }, { namedMinLines: 5 });
  assert.ok(!keep.has("a"), "a (4 lines) dropped when namedMin=5");
  assert.ok(keep.has("b"));
}

// ── Input is not mutated ─────────────────────────────────────────────────────
{
  const scenes = [{ lines: linesFor("drop-me", 1) }];
  const chars = { "drop-me": { name: "Drop Me" } };
  const before = JSON.stringify(scenes);
  consolidateCharacters(chars, scenes);
  assert.equal(JSON.stringify(scenes), before, "original scenes untouched");
  assert.ok(chars["drop-me"], "original characters untouched");
}

console.log("booknlp-consolidate.test.mjs — all assertions passed");
