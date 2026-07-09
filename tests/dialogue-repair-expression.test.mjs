/**
 * Expression Sensitivity Plan Phase 1b/1c — deterministic verb-inference and
 * the missed kind=delivery promotion. Regression case is the exact miss
 * found by hand on Vol.5 Ch.1: a local Ollama pass captured "I shouted at
 * the two of them" verbatim but left it kind=narration and the adjacent
 * dialogue line stuck at expression="normal".
 * Run: node tests/dialogue-repair-expression.test.mjs
 */
import assert from "node:assert";
import { repairSceneLines, inferExpressionFromDelivery } from "../worker/_shared/dialogue-repair.js";

// The motivating bug: stylized verb ("shouted") present as a first-person
// tag, mis-kinded narration by the model — should be promoted to delivery
// AND propagate expression=yell back onto the preceding dialogue line.
{
  const lines = [
    { character_id: "kuro", text: "No major injuries, please,", kind: "dialogue", expression: "normal" },
    { character_id: "narrator", text: "I shouted at the two of them.", kind: "narration" },
  ];
  const out = repairSceneLines(lines);
  assert.equal(out[1].kind, "delivery", "stylized-verb tag should be promoted from narration to delivery");
  assert.equal(out[1].delivery_verb, "shouted");
  assert.equal(out[0].expression, "yell", "adjacent dialogue line should inherit the yell bucket from the shout");
}

// A long narration paragraph that happens to contain a stylized verb should
// NOT be reclassified as a delivery tag — it's prose, not an attribution.
{
  const lines = [{
    character_id: "narrator",
    kind: "narration",
    text: "She sighed and looked out over the valley, remembering everything that had happened since the day they first arrived at the gate.",
  }];
  const out = repairSceneLines(lines);
  assert.equal(out[0].kind, "narration", "long narration prose should stay narration even if it contains a stylized verb");
}

// Adverb-tail fallback: no stylized verb, but "quietly" on the tag line
// nudges bucket to whisper and lowers intensity.
{
  const lines = [
    { character_id: "mei", text: "Are you sure about this?", kind: "dialogue", expression: "normal", intensity: 0.5 },
    { character_id: "narrator", text: "she said quietly.", kind: "narration" },
  ];
  const out = inferExpressionFromDelivery(lines);
  assert.equal(out[0].expression, "whisper");
  assert.ok(out[0].intensity < 0.5, "intensity should be nudged down for a quiet adverb tail");
}

// Already-tagged non-normal lines are left alone.
{
  const lines = [
    { character_id: "kuro", text: "Get out.", kind: "dialogue", expression: "angry", intensity: 0.8 },
    { character_id: "narrator", text: "he whispered.", kind: "narration" },
  ];
  const out = inferExpressionFromDelivery(lines);
  assert.equal(out[0].expression, "angry", "an already-tagged expression must not be overwritten");
}

// Own-text verb detection: the tag never got split into its own line at all
// (whole thing folded into one dialogue line) — still catchable via a scan
// of the dialogue line's own trailing text.
{
  const lines = [{
    character_id: "kuro",
    text: "No major injuries, please, I shouted at the two of them.",
    kind: "dialogue",
    expression: "normal",
  }];
  const out = inferExpressionFromDelivery(lines);
  assert.equal(out[0].expression, "yell", "verb embedded in the dialogue line's own unsplit text should still be caught");
}

console.log("dialogue-repair-expression: all assertions passed");
