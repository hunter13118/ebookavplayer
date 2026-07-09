/**
 * Expression Sensitivity Plan (docs/EXPRESSION_SENSITIVITY_PLAN.md) Phase 2:
 * map an extracted line's expression bucket + intensity onto Edge-TTS
 * prosody offsets. Additive on top of whatever per-character pitch/rate/
 * volume already came from worker/_shared/voice-assign.js — never replaces it.
 */
import { normalizeExpressionBucket } from "./expression-bucket.js";

// Offsets at intensity=1.0; scaled linearly by the line's intensity (0..1)
// before being added to the caller's base pitch/rate/volume.
const PROSODY_TABLE = {
  yell: { pitchHz: 30, ratePct: 12, volumePct: 25 },
  angry: { pitchHz: 12, ratePct: 8, volumePct: 15 },
  whisper: { pitchHz: -15, ratePct: -10, volumePct: -35 },
  sad: { pitchHz: -20, ratePct: -15, volumePct: -8 },
  scared: { pitchHz: 20, ratePct: 20, volumePct: 8 },
  surprised: { pitchHz: 18, ratePct: 8, volumePct: 10 },
  happy: { pitchHz: 10, ratePct: 8, volumePct: 8 },
  excited: { pitchHz: 15, ratePct: 15, volumePct: 10 },
  embarrassed: { pitchHz: 8, ratePct: -3, volumePct: -5 },
  smug: { pitchHz: -5, ratePct: -5, volumePct: 3 },
  tender: { pitchHz: -10, ratePct: -8, volumePct: -8 },
  nervous: { pitchHz: 10, ratePct: 10, volumePct: -3 },
  sarcastic: { pitchHz: -5, ratePct: -5, volumePct: 0 },
  determined: { pitchHz: 5, ratePct: 3, volumePct: 8 },
  desperate: { pitchHz: 18, ratePct: 15, volumePct: 10 },
  normal: { pitchHz: 0, ratePct: 0, volumePct: 0 },
};

const PITCH_CLAMP = [-100, 100]; // Hz
const RATE_CLAMP = [-90, 100]; // %
const VOLUME_CLAMP = [-90, 100]; // %

// Expression Sensitivity Plan Phase 4: "Performance Mode" dial — scales the
// same table above rather than needing a second one.
const PERFORMANCE_SCALE = { subtle: 0.4, balanced: 1, full: 1.6 };

function clamp(n, [lo, hi]) {
  return Math.max(lo, Math.min(hi, n));
}

function parseNum(value) {
  const m = String(value ?? "").trim().match(/^([+-]?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

function addOffset(baseStr, delta, unit, clampRange) {
  const total = clamp(parseNum(baseStr) + delta, clampRange);
  const rounded = Math.round(total);
  return `${rounded >= 0 ? "+" : ""}${rounded}${unit}`;
}

/**
 * @param {{pitch?: string, rate?: string, volume?: string}} base per-character resolved prosody
 * @param {string} expression raw/canonical expression bucket from the line
 * @param {number} intensity 0..1
 * @param {string} performanceMode subtle|balanced|full (default balanced == unscaled)
 */
export function applyExpressionProsody(
  { pitch = "+0Hz", rate = "+0%", volume = "+0%" } = {}, expression, intensity, performanceMode,
) {
  const bucket = normalizeExpressionBucket(expression);
  const table = PROSODY_TABLE[bucket] || PROSODY_TABLE.normal;
  const intensityScale = clamp(typeof intensity === "number" ? intensity : 1, [0, 1]);
  const perfScale = PERFORMANCE_SCALE[performanceMode] ?? PERFORMANCE_SCALE.balanced;
  const scale = intensityScale * perfScale;
  return {
    pitch: addOffset(pitch, table.pitchHz * scale, "Hz", PITCH_CLAMP),
    rate: addOffset(rate, table.ratePct * scale, "%", RATE_CLAMP),
    volume: addOffset(volume, table.volumePct * scale, "%", VOLUME_CLAMP),
  };
}
