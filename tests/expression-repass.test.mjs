/**
 * Expression Sensitivity Plan Phase 1d/1e — focused re-tag pass + flatness
 * audit. Mocks global.fetch so no real provider needs to be running.
 * Run: node tests/expression-repass.test.mjs
 */
import assert from "node:assert";
import {
  runExpressionRepass, auditExpressionFlatness, isExpressionRepassEnabled,
} from "../worker/_shared/expression-repass.js";

const originalFetch = globalThis.fetch;
function mockFetch(handler) { globalThis.fetch = async (url, options) => handler(url, options); }
function restoreFetch() { globalThis.fetch = originalFetch; }

// preferProviderSoft: "ollama-7b" only actually resolves to something
// reachable once OLLAMA_BASE_URL is set (otherwise all four ollama-* stages
// are force-disabled and the chain falls through to cloud providers that
// fail immediately on a missing API key, before ever calling fetch).
const OLLAMA_ENV = { OLLAMA_BASE_URL: "http://localhost:11434" };
function ollamaResponse(payload) {
  return { ok: true, json: async () => ({ message: { content: JSON.stringify(payload) } }) };
}

function scenesFixture() {
  return [
    {
      id: "scene-0001",
      lines: [
        { character_id: "kuro", text: "Hello there.", kind: "dialogue", expression: "normal" },
        { character_id: "narrator", text: "he said quietly.", kind: "narration" },
        { character_id: "mei", text: "Get out of my way!", kind: "dialogue", expression: "normal" },
      ],
    },
  ];
}

// auditExpressionFlatness: 0/2 dialogue-ish lines non-normal -> flagged flat.
{
  const audit = auditExpressionFlatness(scenesFixture());
  assert.equal(audit.lines, 2, "only dialogue/thought lines count, not narration");
  assert.equal(audit.nonNormalPct, 0);
  assert.equal(audit.suspiciouslyFlat, true);
}

// auditExpressionFlatness: above threshold -> not flagged.
{
  const scenes = scenesFixture();
  scenes[0].lines[0].expression = "happy";
  const audit = auditExpressionFlatness(scenes, 5);
  assert.equal(audit.nonNormalPct, 50);
  assert.equal(audit.suspiciouslyFlat, false);
}

// runExpressionRepass: only dialogue/thought lines get sent, results map back
// by global index onto the right (scene, line), freeform values normalize,
// intensity clamps, and non-taggable kinds are untouched.
{
  let seenBody = null;
  mockFetch(async (url, options) => {
    seenBody = JSON.parse(options.body);
    return ollamaResponse({
      lines: [
        { index: 0, expression: "smiling", intensity: 0.4 }, // alias -> happy
        { index: 1, expression: "yell", intensity: 1.7 }, // out-of-range, should clamp to 1
      ],
    });
  });
  const scenes = scenesFixture();
  const out = await runExpressionRepass(scenes, { env: OLLAMA_ENV });
  restoreFetch();

  // Prompt only contains the 2 dialogue lines, numbered 0 and 1, narration excluded.
  const userMsg = seenBody.messages[1].content;
  assert.match(userMsg, /^0\. \(kuro\) Hello there\.$/m);
  assert.match(userMsg, /^1\. \(mei\) Get out of my way!$/m);
  assert.doesNotMatch(userMsg, /he said quietly/);

  assert.equal(out[0].lines[0].expression, "happy", "freeform alias normalizes to canonical bucket");
  assert.equal(out[0].lines[0].intensity, 0.4);
  assert.equal(out[0].lines[2].expression, "yell");
  assert.equal(out[0].lines[2].intensity, 1, "intensity out of 0-1 range clamps");
  assert.equal(out[0].lines[1].kind, "narration", "narration line untouched");

  // Original input is not mutated.
  assert.equal(scenes[0].lines[0].expression, "normal");
}

// runExpressionRepass: a character temperament note is included in the prompt.
{
  let capturedPrompt = "";
  mockFetch(async (url, options) => {
    capturedPrompt = JSON.parse(options.body).messages[1].content;
    return ollamaResponse({ lines: [] });
  });
  await runExpressionRepass(scenesFixture(), {
    env: OLLAMA_ENV,
    temperamentByCharacter: { kuro: "dry and blunt" },
  });
  restoreFetch();
  assert.match(capturedPrompt, /kuro is established as dry and blunt/);
}

// runExpressionRepass: no dialogue/thought lines at all -> returns input untouched, no fetch call.
{
  let called = false;
  mockFetch(async () => { called = true; return { ok: true, json: async () => ({}) }; });
  const scenes = [{ id: "s1", lines: [{ character_id: "narrator", text: "just prose.", kind: "narration" }] }];
  const out = await runExpressionRepass(scenes, { env: {} });
  restoreFetch();
  assert.equal(called, false, "should skip the network call entirely when there's nothing to tag");
  assert.strictEqual(out, scenes);
}

// isExpressionRepassEnabled: only the literal string "true" turns it on.
{
  assert.equal(isExpressionRepassEnabled({ VAE_EXPRESSION_REPASS: "true" }), true);
  assert.equal(isExpressionRepassEnabled({ VAE_EXPRESSION_REPASS: "1" }), false);
  assert.equal(isExpressionRepassEnabled({}), false);
  assert.equal(isExpressionRepassEnabled(undefined), false);
}

console.log("expression-repass: all assertions passed");
