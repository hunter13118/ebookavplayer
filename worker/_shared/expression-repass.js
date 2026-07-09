/**
 * Expression Sensitivity Plan (docs/EXPRESSION_SENSITIVITY_PLAN.md) Phase 1d/1e —
 * a narrow, LLM-backed second pass over already-extracted dialogue/thought
 * lines only (small payload, no chapter text), asking a single focused
 * question: what's the real expression/intensity here. Runs at a higher
 * temperature than the structural mega-pass (0.2) since malformed-JSON risk
 * is much lower for this flat {index, expression, intensity}[] shape than
 * the full nested scene/character tree.
 */
import { freemiumExtract } from "./freemium-extract.js";
import { normalizeExpressionBucket, CANONICAL_EXPRESSION_BUCKETS } from "./expression-bucket.js";

const REPASS_TEMPERATURE = 0.55;
const DIALOGUE_ISH_KINDS = new Set(["dialogue", "thought"]);

// Phase 0's "suspiciously flat" threshold — mirrors scripts/audit_expression.py
// (kept in sync manually; that script is the standalone/manual diagnostic,
// this is the same heuristic wired into the live pipeline for Phase 1e).
const DEFAULT_FLAT_THRESHOLD_PCT = 5;

const SYSTEM_PROMPT = `You are tagging emotional delivery for lines already extracted from a novel.
For each numbered line below, output ONLY {index, expression, intensity} — nothing else.
expression must be one of: ${CANONICAL_EXPRESSION_BUCKETS.join("|")}.
Be decisive: "normal" is reserved for genuinely flat, matter-of-fact lines — default to a specific
emotional read when the line carries any charge (a question, a tease, mild surprise, irritation).
intensity is 0.0-1.0, independent of the bucket — use the full range, don't cluster everything at 0.5.
Return exactly: {"lines": [{"index": 0, "expression": "...", "intensity": 0.0}, ...]} — one entry
per line given, in the same order, nothing else in the response.`;

export function isExpressionRepassEnabled(env) {
  return String(env?.VAE_EXPRESSION_REPASS ?? "false").toLowerCase() === "true";
}

/** Every dialogue/thought line across all scenes, with a stable global index
 *  and a (sceneIdx, lineIdx) address to write results back onto. */
function collectTaggableLines(scenes) {
  const items = [];
  (scenes || []).forEach((scene, sceneIdx) => {
    (scene.lines || []).forEach((line, lineIdx) => {
      if (!DIALOGUE_ISH_KINDS.has(line.kind)) return;
      items.push({
        sceneIdx, lineIdx, character_id: line.character_id, text: line.text,
      });
    });
  });
  return items;
}

function buildRepassPrompt(items, temperamentByCharacter) {
  return items
    .map((it, i) => {
      const temperament = temperamentByCharacter?.[it.character_id];
      const note = temperament ? ` [${it.character_id} is established as ${temperament} — weight accordingly]` : "";
      return `${i}. (${it.character_id}) ${it.text}${note}`;
    })
    .join("\n");
}

/**
 * Runs the focused re-pass and returns a NEW scenes array with
 * expression/intensity overwritten from the model's response. Never
 * mutates the input. Callers should treat failures as best-effort (this is
 * an enhancement pass, not required for the chapter to succeed).
 *
 * @param {Array} scenes AnalysisScene[] (already repaired/attributed)
 * @param {{env, preferProvider?, temperamentByCharacter?}} opts
 */
export async function runExpressionRepass(scenes, {
  env, preferProvider, temperamentByCharacter,
} = {}) {
  const items = collectTaggableLines(scenes);
  if (!items.length) return scenes;

  const userText = buildRepassPrompt(items, temperamentByCharacter);
  // Soft-prefer the cheap/fast local model (Phase 1d: "a good candidate to
  // default to the local model even when the main extraction used cloud")
  // without hard-pinning — falls through to whatever's actually available.
  const { data } = await freemiumExtract(userText, {
    systemPrompt: SYSTEM_PROMPT,
    preferProviderSoft: preferProvider || "ollama-7b",
    env,
    temperature: REPASS_TEMPERATURE,
  });

  const results = Array.isArray(data) ? data : (data?.lines || []);
  const byIndex = new Map(results.filter((r) => r && r.index != null).map((r) => [Number(r.index), r]));

  const next = scenes.map((scene) => ({ ...scene, lines: [...(scene.lines || [])] }));
  items.forEach((it, i) => {
    const r = byIndex.get(i);
    if (!r) return;
    const bucket = normalizeExpressionBucket(r.expression);
    const intensity = typeof r.intensity === "number" ? Math.max(0, Math.min(1, r.intensity)) : undefined;
    const line = next[it.sceneIdx].lines[it.lineIdx];
    next[it.sceneIdx].lines[it.lineIdx] = {
      ...line,
      expression: bucket,
      ...(intensity != null ? { intensity } : {}),
    };
  });
  return next;
}

/**
 * Phase 0/1e: percent of dialogue/thought lines tagged non-"normal", plus
 * whether that's under the "suspiciously flat" threshold. Same heuristic as
 * scripts/audit_expression.py, ported to JS so the live pipeline can act on
 * it (that script stays the standalone/manual diagnostic tool).
 */
export function auditExpressionFlatness(scenes, thresholdPct = DEFAULT_FLAT_THRESHOLD_PCT) {
  const items = collectTaggableLines(scenes);
  if (!items.length) return { lines: 0, nonNormalPct: 0, suspiciouslyFlat: false };
  let sceneList = scenes || [];
  const nonNormal = items.filter((it) => {
    const line = sceneList[it.sceneIdx]?.lines?.[it.lineIdx];
    return normalizeExpressionBucket(line?.expression) !== "normal";
  }).length;
  const nonNormalPct = (100 * nonNormal) / items.length;
  return {
    lines: items.length,
    nonNormalPct: Math.round(nonNormalPct * 10) / 10,
    suspiciouslyFlat: nonNormalPct < thresholdPct,
  };
}
