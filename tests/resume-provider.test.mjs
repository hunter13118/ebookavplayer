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

console.log("resume-provider.test.mjs — all passed");
