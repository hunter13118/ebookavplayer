/**
 * regroupScenesByChapterPos / flattenScenesByChapterPos — the fix for the
 * "scenes shrink then regrow" bug: a chapter's mechanical placeholder scene
 * must get REPLACED in place as it (re-)enriches, never blindly appended to
 * a flat array that starts empty (which used to make the whole book's
 * visible content collapse down to just the first enriched chapter).
 * Run: node tests/scenes-by-chapter-pos.test.mjs
 */
import assert from "node:assert";
import { regroupScenesByChapterPos, flattenScenesByChapterPos } from "../worker/_shared/chapter-extract-pipeline.js";

// Map.set on an existing key preserves its ORIGINAL insertion position —
// the crux of the whole fix: order stays correct book-order regardless of
// which chapter finishes enriching first.
{
  const map = new Map();
  map.set(0, ["ch0-mechanical"]);
  map.set(1, ["ch1-mechanical"]);
  map.set(2, ["ch2-mechanical"]);
  assert.deepEqual(flattenScenesByChapterPos(map), ["ch0-mechanical", "ch1-mechanical", "ch2-mechanical"]);

  // Chapter 1 enriches first (out of "natural" order) — every OTHER
  // chapter's mechanical placeholder must stay visible, not disappear.
  map.set(1, ["ch1-ENRICHED"]);
  assert.deepEqual(flattenScenesByChapterPos(map), ["ch0-mechanical", "ch1-ENRICHED", "ch2-mechanical"]);

  // Chapter 0 enriches next.
  map.set(0, ["ch0-ENRICHED"]);
  assert.deepEqual(flattenScenesByChapterPos(map), ["ch0-ENRICHED", "ch1-ENRICHED", "ch2-mechanical"]);

  // Chapter 2's enrichment (full-regeneration LLM path) produces MULTIPLE
  // scenes for one chapter — the flatten must handle a chapter's scene
  // count changing from 1 to N without breaking book order.
  map.set(2, ["ch2-ENRICHED-a", "ch2-ENRICHED-b"]);
  assert.deepEqual(flattenScenesByChapterPos(map), [
    "ch0-ENRICHED", "ch1-ENRICHED", "ch2-ENRICHED-a", "ch2-ENRICHED-b",
  ]);
}

// regroupScenesByChapterPos: resumed scenes (as read back from
// books/{id}.json) get bucketed by chapterPos via the chapterIndex lookup,
// not by array position — scene.chapter carries the SEMANTIC chapter
// number (chapterAnalysis.chapterIndex), which need not equal its
// positional index (e.g. a book whose first real chapter is numbered "1"
// after an unnumbered prologue at position 0).
{
  const chapterPosByIndex = new Map([[0, 0], [1, 1], [2, 2]]); // prologue=index 0 -> pos 0, etc.
  const scenes = [
    { chapter: 1, id: "s1" }, // chapter index 1 -> pos 1
    { chapter: 0, id: "s0" }, // chapter index 0 -> pos 0 (out of array order on purpose)
    { chapter: 2, id: "s2a" },
    { chapter: 2, id: "s2b" }, // same chapter, two scenes (full-regen path)
  ];
  const map = regroupScenesByChapterPos(scenes, chapterPosByIndex);
  assert.deepEqual([...map.keys()].sort(), [0, 1, 2]);
  assert.deepEqual(map.get(0), [{ chapter: 0, id: "s0" }]);
  assert.deepEqual(map.get(1), [{ chapter: 1, id: "s1" }]);
  assert.deepEqual(map.get(2), [{ chapter: 2, id: "s2a" }, { chapter: 2, id: "s2b" }]);
}

// A scene whose chapter number doesn't resolve in the lookup at all
// (shouldn't normally happen) still gets a bucket instead of being silently
// dropped — appended at the end.
{
  const chapterPosByIndex = new Map([[1, 0]]);
  const scenes = [{ chapter: 1, id: "known" }, { chapter: 99, id: "orphan" }];
  const map = regroupScenesByChapterPos(scenes, chapterPosByIndex);
  assert.equal(map.size, 2);
  assert.ok([...map.values()].flat().some((s) => s.id === "orphan"), "orphaned scene is kept, not dropped");
}

// Empty/undefined scenes array is a safe no-op.
{
  const map = regroupScenesByChapterPos(undefined, new Map());
  assert.equal(map.size, 0);
  assert.deepEqual(flattenScenesByChapterPos(map), []);
}

console.log("scenes-by-chapter-pos.test.mjs: ok");
