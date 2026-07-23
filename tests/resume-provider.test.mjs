/**
 * Which provider a (re)started extraction run uses — an explicit
 * prefer_provider on THIS call must override whatever the checkpoint
 * remembers from earlier chapters, not the other way around. Previously
 * inverted: checkpoint.provider_used always won, silently ignoring a
 * prefer_provider passed to POST /books/:id/continue-extract (discovered
 * live — resuming with prefer_provider: "ollama-14b" kept using the
 * checkpoint's already-persisted "ollama-30b").
 * Run: node tests/resume-provider.test.mjs
 */
import assert from "node:assert";
import { resolveResumeProvider } from "../worker/_shared/chapter-extract-pipeline.js";
import { defaultProviderForSize } from "../worker/api/v1/ingest.js";

// Explicit override wins even when the checkpoint remembers a different provider.
assert.equal(
  resolveResumeProvider("ollama-14b", { provider_used: "ollama-30b" }),
  "ollama-14b",
  "explicit prefer_provider must override the checkpoint's remembered provider",
);

// No explicit request (null/undefined) -> fall back to the checkpoint, so a
// plain "just resume" call stays consistent with earlier chapters.
assert.equal(resolveResumeProvider(null, { provider_used: "ollama-30b" }), "ollama-30b");
assert.equal(resolveResumeProvider(undefined, { provider_used: "ollama-30b" }), "ollama-30b");

// Neither present (fresh book, no checkpoint yet, no explicit request) -> null,
// letting the normal freemium fallback cascade decide.
assert.equal(resolveResumeProvider(null, {}), null);
assert.equal(resolveResumeProvider(null, null), null);
assert.equal(resolveResumeProvider(undefined, undefined), null);

// Explicit request with no checkpoint at all (first-ever run) -> still honored.
assert.equal(resolveResumeProvider("ollama-7b", null), "ollama-7b");

// "booknlp"/"annotate" are non-LLM sentinels written into provider_used when
// a chapter was handled by BookNLP or the annotate-in-place pass, not a real
// freemiumExtract provider id — a resume must not inherit one of these as
// its preferProvider (freemiumExtract treats ANY preferProvider as a hard
// pin with no fallback, so a fake "provider" would immediately exhaust and
// wrongly mark the book partial instead of trying a real LLM). Found live
// while wiring the annotate pass in on top of the already-shipped BookNLP
// integration.
assert.equal(resolveResumeProvider(null, { provider_used: "booknlp" }), null);
assert.equal(resolveResumeProvider(null, { provider_used: "annotate" }), null);
// An explicit pin still wins over a sentinel, same as it wins over a real provider.
assert.equal(resolveResumeProvider("gemini", { provider_used: "booknlp" }), "gemini");
assert.equal(resolveResumeProvider("gemini", { provider_used: "annotate" }), "gemini");

// defaultProviderForSize (ingest.js) — regression for a real stall: a
// <=15-chapter book used to hardcode "gemini" outright regardless of
// EXTRACT_SKIP_GEMINI/a missing GEMINI_API_KEY, and because this becomes a
// PINNED preferProvider for the whole checkpointed job, every chapter failed
// forever with the UI just showing "processing" (found live: a real
// 12-chapter book stalled at 1/12 for hours). Must only ever return a
// provider resolvedExtractProviders actually resolves as enabled.
{
  // gemini disabled (EXTRACT_SKIP_GEMINI), ollama available -> falls back to
  // ollama-30b instead of pinning to a dead "gemini".
  const env = { EXTRACT_SKIP_GEMINI: "true", OLLAMA_BASE_URL: "http://localhost:11434" };
  assert.equal(await defaultProviderForSize(12, env), "ollama-30b",
    "a small book must not pin to gemini when it's disabled and ollama is available");
}
{
  // gemini explicitly enabled -> still prefers it for a small book,
  // unchanged behavior when nothing is actually broken (EXTRACT_SKIP_GEMINI
  // defaults to "true" — see pipeline-registry.js's defaultConfig — so this
  // must be explicit).
  const env = { EXTRACT_SKIP_GEMINI: "false", OLLAMA_BASE_URL: "http://localhost:11434" };
  assert.equal(await defaultProviderForSize(12, env), "gemini");
}
{
  // A larger book still prefers ollama-30b when available, same as before.
  const env = { OLLAMA_BASE_URL: "http://localhost:11434" };
  assert.equal(await defaultProviderForSize(20, env), "ollama-30b");
}
{
  // Nothing at all available (no ollama, gemini disabled, no freemium keys)
  // -> whatever resolvedExtractProviders' chain has left, not a hardcoded
  // guess that could itself be disabled.
  const env = { EXTRACT_SKIP_GEMINI: "true" };
  const result = await defaultProviderForSize(12, env);
  assert.notEqual(result, "gemini");
}

console.log("resume-provider.test.mjs — all passed");
