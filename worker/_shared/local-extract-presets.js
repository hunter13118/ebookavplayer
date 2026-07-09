/**
 * Local (Ollama) extraction presets — which local model should lead the
 * "extract" lane, with effectiveness estimates from real on-device
 * benchmarks (Apple M4 Pro, 48GB, Ollama 0.31.1, OLLAMA_FLASH_ATTENTION=1,
 * 16K ctx — see docs/LOCAL_LLM_EXTRACTION.md). Speed varies by hardware;
 * treat the numbers as relative guidance, not a guarantee.
 */

export const LOCAL_EXTRACT_PRESETS = [
  {
    id: "local_fastest_solo",
    label: "Fastest — one chapter at a time",
    stageId: "ollama-30b",
    effectiveness: "~53 tok/s solo — fastest local model measured",
    summary:
      "qwen3:30b-a3b (Qwen3 MoE) leads extraction. Best pick for the default sequential pipeline (VAE_EXTRACT_CONCURRENCY=1) — beats every other local model tried on single-chapter speed.",
    recommendedEnv: [
      { key: "OLLAMA_FLASH_ATTENTION", value: "1" },
      { key: "OLLAMA_NUM_PARALLEL", value: "1" },
      { key: "VAE_EXTRACT_CONCURRENCY", value: "1" },
    ],
  },
  {
    id: "local_best_concurrent",
    label: "Best for concurrent chapters",
    stageId: "ollama-20b",
    effectiveness: "~44 tok/s solo, ~30 tok/s aggregate at 8-way concurrency",
    summary:
      "gpt-oss:20b (OpenAI MoE) leads extraction. A little slower solo than the Fastest preset, but by far the most concurrency-tolerant local model tried — every other model loses 40-90% of its throughput once VAE_EXTRACT_CONCURRENCY rises above 1, this one barely does.",
    recommendedEnv: [
      { key: "OLLAMA_FLASH_ATTENTION", value: "1" },
      { key: "OLLAMA_NUM_PARALLEL", value: "1" },
      {
        key: "VAE_EXTRACT_CONCURRENCY",
        value: "4",
        note: "only raise this if you actually want multiple chapters extracting at once — 1 is still faster for a single book",
      },
    ],
  },
  {
    id: "local_mlx_concurrent",
    label: "Best for concurrent chapters (MLX, experimental)",
    stageId: "mlx-30b",
    effectiveness: "~18.6 tok/s solo, ~39.1 tok/s aggregate at 8-way concurrency — beats every Ollama config tested for concurrent extraction",
    summary:
      "qwen3:30b-a3b served through Apple's MLX runtime (mlx_lm.server) instead of Ollama. Much slower solo than the Fastest preset, so only worth it once VAE_EXTRACT_CONCURRENCY is deliberately raised above 1 — Apple Silicon only, requires a separate `mlx-lm` Python venv running alongside (not instead of) Ollama.",
    recommendedEnv: [
      { key: "MLX_BASE_URL", value: "http://localhost:8081" },
      {
        key: "VAE_EXTRACT_CONCURRENCY",
        value: "4",
        note: "the whole point of this preset — at concurrency=1 the Fastest (Ollama) preset is faster",
      },
    ],
  },
  {
    id: "local_lightweight",
    label: "Lightweight — smallest download",
    stageId: "ollama-7b",
    effectiveness: "~42 tok/s solo, 4.7GB download vs. 13-18GB for the MoE options",
    summary:
      "qwen2.5:7b — the original baseline model. Reasonable choice on tighter disk/RAM budgets, or hardware where the larger MoE models haven't been validated.",
    recommendedEnv: [
      {
        key: "OLLAMA_FLASH_ATTENTION",
        value: "1",
        note: "neutral for this model (measured, doesn't help or hurt) — harmless to leave on",
      },
      { key: "OLLAMA_NUM_PARALLEL", value: "1" },
      { key: "VAE_EXTRACT_CONCURRENCY", value: "1" },
    ],
  },
];

function firstEnabled(laneDef) {
  const disabled = new Set(laneDef?.disabled || []);
  return (laneDef?.order || []).find((id) => !disabled.has(id)) || null;
}

/** Which preset (if any) matches the live extract-lane config right now. */
export function activeLocalExtractPreset(cfg) {
  const leader = firstEnabled(cfg.extract);
  return LOCAL_EXTRACT_PRESETS.find((p) => p.stageId === leader)?.id || null;
}

/** Patch object for PATCH /pipeline — moves the preset's stage to the front
 * of the extract lane without disabling any other stage (still a fallback
 * chain, just reordered). */
export function localExtractPresetPatch(cfg, presetId) {
  const preset = LOCAL_EXTRACT_PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  const base = cfg.extract || { order: [], disabled: [] };
  const order = [preset.stageId, ...(base.order || []).filter((id) => id !== preset.stageId)];
  return { extract: { order, disabled: [...(base.disabled || [])] } };
}
