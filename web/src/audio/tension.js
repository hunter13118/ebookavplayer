/**
 * Expression Sensitivity Plan (docs/EXPRESSION_SENSITIVITY_PLAN.md) Phase 4:
 * a lightweight per-scene "tension" value that accumulates across
 * consecutive high-intensity lines and decays on calm narration, independent
 * of any single line's tag — so an escalating argument *builds* visually
 * across several lines rather than each line reacting in isolation.
 */
import { normalizeExpressionBucket } from "../expressionBucket.js";

const BUILD_RATE = 0.35;
const DECAY_RATE = 0.25;

/** @returns {number} next tension value, clamped 0..1 */
export function nextTension(prevTension, line) {
  const prev = typeof prevTension === "number" ? prevTension : 0;
  if (!line) return Math.max(0, prev - DECAY_RATE);
  const bucket = normalizeExpressionBucket(line.expression);
  const intensity = typeof line.intensity === "number" ? line.intensity : 1;
  const isDramatic = bucket !== "normal" && intensity > 0.5;
  if (isDramatic) return Math.min(1, prev + BUILD_RATE * intensity);
  return Math.max(0, prev - DECAY_RATE);
}
