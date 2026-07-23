/**
 * Mechanical quote-boundary splitting (Plan One Phase 2) — segmentByQuotes
 * pairs every opening quote mark with its next closing one at the WHOLE-
 * CHAPTER level (not per-sentence), so a multi-sentence quote becomes one
 * dialogue region instead of two unbalanced fragments. buildMechanicalChapterLines
 * then sentence-splits narration regions and emits dialogue regions as their
 * own (character_id-unresolved) lines, quote marks stripped.
 * Run: node tests/mechanical-quote-split.test.mjs
 */
import assert from "node:assert";
import { segmentByQuotes, buildMechanicalChapterLines, buildMechanicalScenes } from "../worker/_shared/mechanical-script.js";

// Narration lead-in + dialogue, straight quotes — the base case.
{
  const lines = buildMechanicalChapterLines(`Kosuke said, "Let's go."`, [], {});
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, "narration");
  assert.equal(lines[0].character_id, "narrator");
  assert.equal(lines[0].text, "Kosuke said,");
  assert.equal(lines[1].kind, "dialogue");
  assert.equal(lines[1].character_id, undefined, "unresolved — pending enrichment");
  assert.equal(lines[1].text, "Let's go.", "quote marks stripped from dialogue text");
}

// Curly quotes, two separate dialogue spans around one narration tag.
{
  const lines = buildMechanicalChapterLines("“Hello,” she said. “Are you lost?”", [], {});
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.kind), ["dialogue", "narration", "dialogue"]);
  assert.equal(lines[0].text, "Hello,");
  assert.equal(lines[1].text, "she said.");
  assert.equal(lines[2].text, "Are you lost?");
}

// A sentence that's entirely a quote (no narration lead-in) -> one dialogue line.
{
  const lines = buildMechanicalChapterLines('"The coin only summoned me."', [], {});
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "dialogue");
  assert.equal(lines[0].text, "The coin only summoned me.");
}

// Multi-sentence quote — the case region-level (not per-sentence) scanning
// specifically fixes: stays ONE dialogue line spanning both sentences,
// rather than two unbalanced fragments each falling back to narration.
{
  const lines = buildMechanicalChapterLines('"It is cold. The wind howls," she said.', [], {});
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, "dialogue");
  assert.equal(lines[0].text, "It is cold. The wind howls,");
  assert.equal(lines[1].kind, "narration");
  assert.equal(lines[1].text, "she said.");
}

// Unbalanced open quote — conservative fallback: no crash, no dropped text,
// stays as one narration line with the literal quote mark retained (same
// behavior as before this feature existed — not a regression).
{
  const lines = buildMechanicalChapterLines('"It is cold.', [], {});
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "narration");
  assert.equal(lines[0].text, '"It is cold.');
}

// Apostrophes (contraction/possessive) never trigger a false split — single
// quote is deliberately not a delimiter.
{
  const lines = buildMechanicalChapterLines("It's Mei's book.", [], {});
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "narration");
  assert.equal(lines[0].text, "It's Mei's book.");
}

// Straight-quote dialogue containing its own apostrophe — the apostrophe
// stays untouched while the enclosing straight quotes are still detected.
{
  const lines = buildMechanicalChapterLines('"Let\'s go," he said.', [], {});
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, "dialogue");
  assert.equal(lines[0].text, "Let's go,");
  assert.equal(lines[1].text, "he said.");
}

// segmentByQuotes: quote-free text is a single narration region (cheap
// early-out, no scanning needed).
{
  const regions = segmentByQuotes("Nothing quoted here at all.");
  assert.deepEqual(regions, [{ type: "narration", text: "Nothing quoted here at all." }]);
}

// buildMechanicalScenes end-to-end: dialogue line's kind/character_id
// survive compilation-shape mapping; still narrator-voiced (unresolved);
// idx stays continuous; illustration slotting still lands correctly when
// one sentence becomes multiple lines.
{
  const chapters = [
    { index: 1, title: "Ch1", text: 'Kosuke said, "Let\'s go now quickly." Sylphie nodded.' },
  ];
  const byChapterPos = new Map([[0, [{ index: 0, textContext: "let's go now quickly, he urged" }]]]);
  const urls = { 0: "/media/plate.jpg" };
  const { scenes, lineCount } = buildMechanicalScenes(chapters, byChapterPos, urls);

  const lines = scenes[0].lines;
  assert.equal(lineCount, 3);
  assert.deepEqual(lines.map((l) => l.idx), [0, 1, 2]);
  assert.deepEqual(lines.map((l) => l.kind), ["narration", "dialogue", "narration"]);
  assert.equal(lines[1].character_id, "narrator", "unresolved dialogue defaults to narrator, same as before enrichment");
  assert.equal(lines[1].speaker_name, "Narrator");
  assert.ok(lines[1].voice, "narrator voice resolved even for an unresolved-speaker dialogue line");
  // The image's textContext best-matches the dialogue line's own text, not
  // just the last line in the chapter — confirms anchorTexts stayed
  // index-aligned with lines after quote-splitting multiplied line count.
  assert.equal(lines[1].illustration_url, "/media/plate.jpg");
}

console.log("mechanical-quote-split.test.mjs: ok");
