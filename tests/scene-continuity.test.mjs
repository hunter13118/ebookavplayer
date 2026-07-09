/**
 * Scene continuity across chunk boundaries — a chunk that ends mid-scene
 * (chunk boundary, not a real scene end) can flag `scene_continues: true` on
 * its trailing scene; the next chunk is told to reuse that exact scene id,
 * and mergeChapterScenes stitches the two chunk-local partial scenes back
 * into one. Purely additive: if the model never sets the flag, behavior is
 * identical to a plain concat (today's pre-existing behavior).
 * Run: node tests/scene-continuity.test.mjs
 */
import assert from "node:assert";
import { mergeChapterScenes, buildUserPrompt } from "../worker/_shared/freemium-extract.js";

function scene(overrides) {
  return {
    id: "scene-0001",
    chapter: 1,
    title: "Forest at Night",
    location: "forest",
    background_desc: "dark woods",
    present_character_ids: ["kuro"],
    lines: [{ character_id: "kuro", text: "hello", kind: "dialogue" }],
    ...overrides,
  };
}

// No flag at all -> identical to today's plain concatenation.
{
  const partials = [
    { scenes: [scene({ id: "scene-0001" })] },
    { scenes: [scene({ id: "scene-0001", lines: [{ character_id: "kuro", text: "again", kind: "dialogue" }] })] },
  ];
  const merged = mergeChapterScenes(partials);
  assert.equal(merged.length, 2, "no scene_continues flag -> no stitching, plain concat");
}

// Flagged continuation with a matching id on the next chunk's first scene -> stitched into one.
{
  const partials = [
    { scenes: [scene({ id: "scene-0001", scene_continues: true, lines: [{ character_id: "kuro", text: "part one", kind: "dialogue" }] })] },
    { scenes: [scene({ id: "scene-0001", lines: [{ character_id: "kuro", text: "part two", kind: "dialogue" }] })] },
  ];
  const merged = mergeChapterScenes(partials);
  assert.equal(merged.length, 1, "matching continuation -> stitched into one scene");
  assert.equal(merged[0].lines.length, 2, "lines from both chunks concatenated in order");
  assert.equal(merged[0].lines[0].text, "part one");
  assert.equal(merged[0].lines[1].text, "part two");
  assert.equal(merged[0].scene_continues, undefined, "internal flag stripped from final output");
}

// Continuation spanning 3 chunks (long scene) — multi-hop stitching.
{
  const partials = [
    { scenes: [scene({ id: "scene-0001", scene_continues: true, lines: [{ text: "a" }] })] },
    { scenes: [scene({ id: "scene-0001", scene_continues: true, lines: [{ text: "b" }] })] },
    { scenes: [scene({ id: "scene-0001", lines: [{ text: "c" }] })] },
  ];
  const merged = mergeChapterScenes(partials);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].lines.map((l) => l.text), ["a", "b", "c"]);
}

// Model flagged continuation but didn't comply (different id next chunk) ->
// falls back gracefully, no crash, no data loss.
{
  const partials = [
    { scenes: [scene({ id: "scene-0001", scene_continues: true })] },
    { scenes: [scene({ id: "scene-0002" })] },
  ];
  const merged = mergeChapterScenes(partials);
  assert.equal(merged.length, 2, "non-matching id -> both scenes kept separately, no crash");
}

// present_character_ids union across the stitch (someone enters mid-scene).
{
  const partials = [
    { scenes: [scene({ id: "scene-0001", scene_continues: true, present_character_ids: ["kuro"] })] },
    { scenes: [scene({ id: "scene-0001", present_character_ids: ["kuro", "mei"] })] },
  ];
  const merged = mergeChapterScenes(partials);
  assert.deepEqual(merged[0].present_character_ids.sort(), ["kuro", "mei"]);
}

// Chapter ends still "open" (last chunk's trailing scene never resolves) —
// take what we have rather than dropping it.
{
  const partials = [
    { scenes: [scene({ id: "scene-0001", scene_continues: true, lines: [{ text: "only this" }] })] },
  ];
  const merged = mergeChapterScenes(partials);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].lines[0].text, "only this");
}

// buildUserPrompt includes the open-scene note only when one is passed.
{
  const withNote = buildUserPrompt("b1", "T", "A", "text", 1, 3, [], [], {
    id: "scene-0004", location: "throne room", title: "Throne Room at Dawn", present_character_ids: ["emperor"],
  });
  assert.match(withNote, /OPEN SCENE FROM PREVIOUS CHUNK/);
  assert.match(withNote, /scene-0004/);
  assert.match(withNote, /emperor/);

  const withoutNote = buildUserPrompt("b1", "T", "A", "text", 1, 3, [], [], null);
  assert.doesNotMatch(withoutNote, /OPEN SCENE FROM PREVIOUS CHUNK/);
}

console.log("scene-continuity.test.mjs — all passed");
