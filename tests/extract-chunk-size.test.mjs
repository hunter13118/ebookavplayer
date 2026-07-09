/**
 * EXTRACT_CHUNK_MAX_TOKENS — documented in .env.example and referenced in
 * docs/LOCAL_LLM_EXTRACTION.md's troubleshooting table as the way to chunk a
 * book smaller, but never actually wired to any code (MAX_CHUNK_TOKENS was a
 * dead-hardcoded constant). This covers the resolver, plus that a smaller
 * resolved value actually produces more, smaller chunks end to end.
 * Run: node tests/extract-chunk-size.test.mjs
 */
import assert from "node:assert";
import { resolveMaxChunkTokens, resolveOllamaNumCtx, chunkText } from "../worker/_shared/freemium-extract.js";
import { chunkChaptersStrict } from "../worker/_shared/epub-text.js";

// Resolver: falls back to the default when unset/invalid, honors a valid override.
{
  assert.equal(resolveMaxChunkTokens({}), 2000, "no env var -> default");
  assert.equal(resolveMaxChunkTokens({ EXTRACT_CHUNK_MAX_TOKENS: "800" }), 800, "valid override honored");
  assert.equal(resolveMaxChunkTokens({ EXTRACT_CHUNK_MAX_TOKENS: "not-a-number" }), 2000, "garbage falls back to default");
  assert.equal(resolveMaxChunkTokens({ EXTRACT_CHUNK_MAX_TOKENS: "-5" }), 2000, "non-positive falls back to default");
  assert.equal(resolveMaxChunkTokens(undefined), 2000, "missing env object doesn't throw");
}

// resolveOllamaNumCtx — scales with the resolved chunk budget at the proven
// 8x ratio, floors out instead of going dangerously small, and an explicit
// OLLAMA_NUM_CTX always wins outright.
{
  assert.equal(resolveOllamaNumCtx({}), 16000, "default chunk budget (2000) * 8 ratio");
  assert.equal(
    resolveOllamaNumCtx({ EXTRACT_CHUNK_MAX_TOKENS: "800" }), 6400,
    "smaller chunk budget scales the context window down with it",
  );
  assert.equal(
    resolveOllamaNumCtx({ EXTRACT_CHUNK_MAX_TOKENS: "100" }), 4096,
    "tiny chunk budget still floors at 4096, never goes small enough to risk truncating output",
  );
  assert.equal(
    resolveOllamaNumCtx({ EXTRACT_CHUNK_MAX_TOKENS: "800", OLLAMA_NUM_CTX: "12000" }), 12000,
    "explicit OLLAMA_NUM_CTX overrides the computed value outright",
  );
}

// A smaller resolved token budget actually yields more, smaller chunks for
// the same text — the whole point of the knob.
{
  const paragraph = "Sentence one here. Sentence two follows along. Sentence three wraps it up.\n\n";
  const longText = paragraph.repeat(80); // long enough to force multiple chunks either way

  const bigChunks = chunkText(longText, resolveMaxChunkTokens({}));
  const smallChunks = chunkText(longText, resolveMaxChunkTokens({ EXTRACT_CHUNK_MAX_TOKENS: "200" }));

  assert.ok(smallChunks.length > bigChunks.length, "smaller token budget -> more chunks");
  for (const c of smallChunks) assert.ok(c.length <= 200 * 4 + 1, "each small chunk respects the smaller ceiling");
}

// Same effect through the chapter-strict chunker used by the actual
// checkpointed extraction path (freemiumExtractBookByChapter).
{
  const chapters = [{
    index: 1,
    title: "Chapter 1",
    text: "Word word word word word word word word word word. ".repeat(200),
  }];

  const bigChars = resolveMaxChunkTokens({}) * 4;
  const smallChars = resolveMaxChunkTokens({ EXTRACT_CHUNK_MAX_TOKENS: "300" }) * 4;

  const bigChunks = chunkChaptersStrict(chapters, bigChars);
  const smallChunks = chunkChaptersStrict(chapters, smallChars);

  assert.ok(smallChunks.length > bigChunks.length, "chapter-strict chunking also scales with the resolved budget");
  // Chapter identity must survive regardless of how many pieces it's split into.
  for (const c of smallChunks) assert.equal(c.chapterIndex, 1);
}

console.log("extract-chunk-size.test.mjs — all passed");
