/**
 * annotate-extract.js — the LLM only declares a character roster and
 * assigns a speaker to each already-split mechanical dialogue line by idx;
 * it never rewrites/re-splits/reorders text. Mocks global.fetch (same
 * pattern as tests/mlx-extract.test.mjs) so no real LLM call is made.
 * Run: node tests/annotate-extract.test.mjs
 */
import assert from "node:assert";
import { annotateChapter, isAnnotateEnabled } from "../worker/_shared/annotate-extract.js";

const originalFetch = globalThis.fetch;
function mockFetch(handler) {
  globalThis.fetch = async (url, options) => handler(url, options);
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}
function ollamaResponse(content) {
  return { ok: true, json: async () => ({ message: { content: JSON.stringify(content) } }) };
}

// isAnnotateEnabled: same off-by-default convention as isAttrLlmEnabled/isBooknlp.
{
  assert.equal(isAnnotateEnabled({}), false);
  assert.equal(isAnnotateEnabled({ VAE_ANNOTATE_LLM: "true" }), true);
  assert.equal(isAnnotateEnabled({ VAE_ANNOTATE_LLM: "false" }), false);
}

// Basic single-batch flow: characters declared, dialogue line assigned by
// idx, narration line's character_id/text untouched.
{
  mockFetch(async () => ollamaResponse({
    characters: [{ id: "mira", name: "Mira", gender: "female", importance: "secondary" }],
    assignments: [{ idx: 1, character_id: "mira" }],
  }));

  const chapter = { index: 3, title: "Chapter 3" };
  const chapterText = 'Mira pulled her cloak tighter. "The wards still hum," she said.';
  const { chapterAnalysis, provider } = await annotateChapter({
    chapter, chapterText, knownCharacters: [], env: { OLLAMA_BASE_URL: "http://localhost:11434" },
    preferProvider: "ollama-30b",
  });
  restoreFetch();

  assert.equal(provider, "ollama-30b");
  assert.equal(chapterAnalysis.chapterIndex, 3);
  assert.equal(chapterAnalysis.characters.length, 1);
  assert.equal(chapterAnalysis.characters[0].id, "mira");
  assert.equal(chapterAnalysis.characters[0].importance, "secondary");

  const lines = chapterAnalysis.scenes[0].lines;
  assert.equal(lines.length, 3, "narration lead-in, dialogue, narration tag — quote-split before the LLM ever ran");
  assert.equal(lines[0].kind, "narration");
  assert.equal(lines[0].character_id, "narrator");
  assert.equal(lines[0].text, "Mira pulled her cloak tighter.", "text unchanged — never rewritten");
  assert.equal(lines[1].kind, "dialogue");
  assert.equal(lines[1].character_id, "mira", "assigned by idx");
  assert.equal(lines[1].attribution_source, "annotate");
  assert.equal(lines[1].text, "The wards still hum,", "quote marks already stripped by the mechanical pass, untouched here");
  assert.equal(lines[2].kind, "narration");
  assert.equal(lines[2].character_id, "narrator", "narration is never assigned a speaker");

  assert.deepEqual(chapterAnalysis.scenes[0].present_character_ids, ["mira"]);
}

// A dialogue line the model never assigned stays character_id-absent (no
// crash, no fabricated placeholder — compileChapterPlayback defaults it to
// narrator downstream, same as an unresolved mechanical line).
{
  mockFetch(async () => ollamaResponse({ characters: [], assignments: [] }));
  const { chapterAnalysis } = await annotateChapter({
    chapter: { index: 1, title: "Ch1" },
    chapterText: '"Wait!" she shouted.',
    env: { OLLAMA_BASE_URL: "http://localhost:11434" },
    preferProvider: "ollama-30b",
  });
  restoreFetch();
  const dialogueLine = chapterAnalysis.scenes[0].lines.find((l) => l.kind === "dialogue");
  assert.equal(dialogueLine.character_id, undefined);
  assert.equal(dialogueLine.attribution_source, undefined);
}

// Known characters seed the roster and are reused (not duplicated) even
// when the model re-declares the same id with different details — known/
// earlier declarations win, matching the LLM full-regeneration path's own
// cross-chapter continuity convention.
{
  mockFetch(async () => ollamaResponse({
    characters: [{ id: "orin", name: "Orin the Bandit", gender: "unknown" }], // model re-declares with different name
    assignments: [{ idx: 0, character_id: "orin" }],
  }));
  const { chapterAnalysis } = await annotateChapter({
    chapter: { index: 2, title: "Ch2" },
    chapterText: '"Keep moving."',
    knownCharacters: [{ id: "orin", name: "Orin", gender: "male", importance: "primary" }],
    env: { OLLAMA_BASE_URL: "http://localhost:11434" },
    preferProvider: "ollama-30b",
  });
  restoreFetch();
  assert.equal(chapterAnalysis.characters.length, 1, "not duplicated");
  assert.equal(chapterAnalysis.characters[0].name, "Orin", "known/earlier declaration wins over the model's re-declaration");
  assert.equal(chapterAnalysis.characters[0].gender, "male");
}

// Multi-batch reassembly: a chapter with enough dialogue lines to exceed one
// batch's char budget gets split into 2+ LLM calls, each call's assignments
// keyed by that line's GLOBAL (chapter-wide) idx, not a per-batch-local one —
// confirms batching never scrambles which line an assignment lands on.
{
  const sentences = Array.from({ length: 60 }, (_, i) => `"Line number ${i} of the exchange," said someone.`);
  const chapterText = sentences.join(" ");

  let callCount = 0;
  mockFetch(async (url, options) => {
    callCount += 1;
    const body = JSON.parse(options.body);
    const userContent = body.messages[1].content;
    const payload = JSON.parse(userContent.slice(userContent.indexOf("{")));
    // Assign every dialogue line in THIS batch to a speaker unique to the
    // batch, so we can later confirm every idx across the whole chapter
    // resolved — not just the first batch's.
    const assignments = payload.lines
      .filter((l) => l.kind === "dialogue")
      .map((l) => ({ idx: l.idx, character_id: `speaker-batch${callCount}` }));
    return ollamaResponse({ characters: [], assignments });
  });

  const { chapterAnalysis } = await annotateChapter({
    chapter: { index: 5, title: "Ch5" },
    chapterText,
    env: { OLLAMA_BASE_URL: "http://localhost:11434", EXTRACT_CHUNK_MAX_TOKENS: "1" },
    preferProvider: "ollama-30b",
  });
  restoreFetch();

  assert.ok(callCount >= 2, `expected multiple batches, got ${callCount} call(s)`);
  const dialogueLines = chapterAnalysis.scenes[0].lines.filter((l) => l.kind === "dialogue");
  assert.equal(dialogueLines.length, 60);
  assert.ok(dialogueLines.every((l) => l.character_id), "every dialogue line across every batch got an assignment");
  // Different batches assigned different speaker ids — confirms batch 2's
  // assignments didn't just overwrite/duplicate batch 1's on the same idx.
  const distinctSpeakers = new Set(dialogueLines.map((l) => l.character_id));
  assert.ok(distinctSpeakers.size >= 2, "assignments from different batches landed on different lines correctly");
}

console.log("annotate-extract.test.mjs: ok");
