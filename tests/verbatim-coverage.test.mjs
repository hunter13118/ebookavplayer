/**
 * findMissingVerbatimText — diffs raw EPUB chapter text against the LLM-
 * reconstructed line text, surfacing anything the extraction dropped (e.g.
 * an attribution tag like "he said quietly.").
 * Run: node tests/verbatim-coverage.test.mjs
 */
import assert from "node:assert";
import { findMissingVerbatimText, repairChapterVerbatimCoverage } from "../worker/_shared/verbatim-coverage.js";

// A dropped attribution tag mid-paragraph — the exact symptom this exists to catch.
{
  const source = "\"I'm fine,\" Kosuke said quietly. Sylphie frowned at him, unconvinced by the lie.";
  const reconstructed = "\"I'm fine,\" Sylphie frowned at him, unconvinced by the lie.";
  const missing = findMissingVerbatimText(source, reconstructed);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].text, "Kosuke said quietly.");
}

// A perfectly-preserved chapter reports nothing missing.
{
  const text = "The morning sun rose over the badlands, and Kosuke stretched, ready for another day of survival.";
  assert.deepEqual(findMissingVerbatimText(text, text), []);
}

// Formatting-only differences (curly vs straight quotes, extra whitespace)
// are not real drops — normalization should absorb them.
{
  const source = "“Wait,” she said, “don’t go.”";
  const reconstructed = "\"Wait,\" she said,   \"don't go.\"";
  assert.deepEqual(findMissingVerbatimText(source, reconstructed), []);
}

// A short mid-paragraph substitution (one word swapped, everything else
// verbatim) stays narrowly scoped — resync recovers right after it instead
// of misdiagnosing the rest of the chapter as missing.
{
  const source = "He walked across the room slowly and picked up the ancient dusty tome from the shelf, then turned to leave the quiet library.";
  const reconstructed = "He walked across the room slowly and picked up the ancient ORNATE tome from the shelf, then turned to leave the quiet library.";
  const missing = findMissingVerbatimText(source, reconstructed);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].text, "dusty");
}

// A trailing chunk dropped entirely at the end of the chapter (reconstruction
// just stops early) is still detected, anchored after the last real word.
{
  const source = "The chapter began normally. Then it continued for a while. This is the final sentence that got cut off entirely.";
  const reconstructed = "The chapter began normally. Then it continued for a while.";
  const missing = findMissingVerbatimText(source, reconstructed);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].text, "This is the final sentence that got cut off entirely.");
}

// repairChapterVerbatimCoverage: splices a dropped attribution tag back in
// as a new narrator line, right after the dialogue it followed.
{
  const scenes = [{
    id: "s1",
    lines: [
      { character_id: "kosuke", kind: "dialogue", text: "I'm fine," },
      { character_id: "sylphie", kind: "dialogue", text: "You don't look fine." },
    ],
  }];
  const sourceText = "\"I'm fine,\" Kosuke said quietly. \"You don't look fine.\"";
  const { scenes: repaired, insertedCount } = repairChapterVerbatimCoverage(scenes, sourceText);
  assert.equal(insertedCount, 1);
  assert.equal(repaired[0].lines.length, 3);
  assert.equal(repaired[0].lines[1].text, "Kosuke said quietly.");
  assert.equal(repaired[0].lines[1].character_id, "narrator");
  assert.equal(repaired[0].lines[1].kind, "narration");
  // Original lines untouched by reference (pure — new array/objects only).
  assert.equal(repaired[0].lines[0].text, "I'm fine,");
  assert.equal(repaired[0].lines[2].text, "You don't look fine.");
}

// No drops -> scenes come back unchanged (same reference), insertedCount 0.
{
  const scenes = [{ id: "s1", lines: [{ character_id: "narrator", kind: "narration", text: "All present and accounted for." }] }];
  const result = repairChapterVerbatimCoverage(scenes, "All present and accounted for.");
  assert.equal(result.insertedCount, 0);
  assert.strictEqual(result.scenes, scenes);
}

// Multiple drops across multiple lines land in the right place, in the right order.
{
  const scenes = [{
    id: "s1",
    lines: [
      { character_id: "kosuke", kind: "dialogue", text: "Wait." },
      { character_id: "sylphie", kind: "dialogue", text: "What is it?" },
    ],
  }];
  const sourceText = "\"Wait.\" Kosuke called out. \"What is it?\" she replied, tilting her head.";
  const { scenes: repaired, insertedCount } = repairChapterVerbatimCoverage(scenes, sourceText);
  assert.equal(insertedCount, 2);
  assert.equal(repaired[0].lines.length, 4);
  assert.equal(repaired[0].lines[0].text, "Wait.");
  assert.equal(repaired[0].lines[1].text, "Kosuke called out.");
  assert.equal(repaired[0].lines[2].text, "What is it?");
  assert.equal(repaired[0].lines[3].text, "she replied, tilting her head.");
}

// A short coincidental phrase repeat sits BEFORE the real, longer resync
// point — the longest-match preference should skip the short false lead and
// find the true (longer, more trustworthy) resync instead of stopping early.
{
  const source = "He said the plan was ready. Then he said the whole thing collapsed into chaos and ruin.";
  // Reconstruction drops "He said the plan was ready." entirely, but its own
  // remaining text happens to start with "he said the" too (a real repeat in
  // this sentence) before the genuinely long shared tail resumes.
  const reconstructed = "Then he said the whole thing collapsed into chaos and ruin.";
  const missing = findMissingVerbatimText(source, reconstructed);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].text, "He said the plan was ready.");
}

console.log("verbatim-coverage.test.mjs: ok");
