/**
 * Expression Sensitivity Plan Phase 2 — expression/intensity -> TTS prosody.
 * Run: node tests/expression-prosody.test.mjs
 */
import assert from "node:assert";
import { applyExpressionProsody } from "../worker/_shared/expression-prosody.js";
import { normalizeExpressionBucket } from "../worker/_shared/expression-bucket.js";

// normal/no intensity should be a no-op on the base prosody.
{
  const out = applyExpressionProsody({ pitch: "+0Hz", rate: "+0%", volume: "+0%" }, "normal", 1);
  assert.equal(out.pitch, "+0Hz");
  assert.equal(out.rate, "+0%");
  assert.equal(out.volume, "+0%");
}

// yell at full intensity should raise pitch/rate/volume.
{
  const out = applyExpressionProsody({ pitch: "+0Hz", rate: "+0%", volume: "+0%" }, "yell", 1);
  assert.equal(out.pitch, "+30Hz");
  assert.equal(out.rate, "+12%");
  assert.equal(out.volume, "+25%");
}

// whisper should be negative on all three axes, and scale down with intensity.
{
  const full = applyExpressionProsody({ pitch: "+0Hz", rate: "+0%", volume: "+0%" }, "whisper", 1);
  const half = applyExpressionProsody({ pitch: "+0Hz", rate: "+0%", volume: "+0%" }, "whisper", 0.5);
  assert.equal(full.volume, "-35%");
  assert.equal(half.volume, "-17%"); // -35 * 0.5 = -17.5, Math.round rounds half toward +Infinity
}

// combines additively on top of an existing per-character pitch override,
// rather than replacing it.
{
  const out = applyExpressionProsody({ pitch: "+35Hz", rate: "+0%", volume: "+0%" }, "angry", 1);
  assert.equal(out.pitch, "+47Hz"); // 35 + 12
}

// freeform values normalize onto the canonical bucket before lookup.
{
  const out = applyExpressionProsody({ pitch: "+0Hz", rate: "+0%", volume: "+0%" }, "giggling", 1);
  assert.equal(out.volume, "+8%"); // giggling -> happy
  assert.equal(normalizeExpressionBucket("giggling"), "happy");
  assert.equal(normalizeExpressionBucket("SHOUTING"), "yell");
  assert.equal(normalizeExpressionBucket("something-unrecognized"), "normal");
}

// missing/undefined intensity defaults to full strength (1.0), matching the
// AnalysisLine/PlaybackLine schema default.
{
  const out = applyExpressionProsody({ pitch: "+0Hz", rate: "+0%", volume: "+0%" }, "yell", undefined);
  assert.equal(out.pitch, "+30Hz");
}

// Phase 4 performance mode: subtle dampens, full amplifies, missing/unknown
// mode behaves exactly like "balanced" (unscaled) for backward compat.
{
  const base = { pitch: "+0Hz", rate: "+0%", volume: "+0%" };
  const balanced = applyExpressionProsody(base, "yell", 1, "balanced");
  const noMode = applyExpressionProsody(base, "yell", 1, undefined);
  const subtle = applyExpressionProsody(base, "yell", 1, "subtle");
  const full = applyExpressionProsody(base, "yell", 1, "full");
  assert.equal(balanced.pitch, "+30Hz");
  assert.equal(noMode.pitch, "+30Hz", "missing performance_mode matches balanced");
  assert.equal(subtle.pitch, "+12Hz"); // 30 * 0.4
  assert.equal(full.pitch, "+48Hz"); // 30 * 1.6
}

console.log("expression-prosody: all assertions passed");
