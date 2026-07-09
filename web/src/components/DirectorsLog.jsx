import { normalizeExpressionBucket } from "../expressionBucket.js";

/**
 * Expression Sensitivity Plan (docs/EXPRESSION_SENSITIVITY_PLAN.md) Phase 4
 * "director's log" debug overlay: the resolved expression/intensity/bucket
 * for the current line in a small corner readout, so tuning Phases 1-3 is
 * observable instead of guessing from vibes. User-facing toggle (Settings →
 * Display → "Director's log", vae-directors-log in voicePrefs.js), default
 * off — works in both dev and prod builds since it's a legitimate tuning
 * tool, not just a dev artifact.
 */
export default function DirectorsLog({
  line, speakerName, performanceMode, tension, enabled,
}) {
  if (!enabled || !line) return null;
  const bucket = normalizeExpressionBucket(line.expression);
  const intensity = typeof line.intensity === "number" ? line.intensity : 1;

  return (
    <div className="vae-directors-log" data-testid="directors-log" aria-hidden="true">
      <div className="vae-directors-log-title">director&rsquo;s log</div>
      <div>speaker: {speakerName || line.character_id || "narrator"}</div>
      <div>kind: {line.kind || "dialogue"}</div>
      <div>expression: {line.expression || "normal"} → {bucket}</div>
      <div>intensity: {intensity.toFixed(2)}</div>
      <div>performance: {performanceMode || "balanced"}</div>
      <div>tension: {(tension ?? 0).toFixed(2)}</div>
    </div>
  );
}
