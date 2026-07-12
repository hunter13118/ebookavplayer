/**
 * Pipeline registry for edge Worker — mirrors server/pipeline/registry.py.
 * Config persisted in KV `pipeline:config`; drives freemium chain order.
 */
import { evaluateCostEfficiency } from "./pipeline-cost-guide.js";
import { LOCAL_EXTRACT_PRESETS, activeLocalExtractPreset } from "./local-extract-presets.js";

const KV_KEY = "pipeline:config";

const IMAGE_FREEMIUM_DEFAULT = [
  "pollinations-anon",
  "pollinations-seed",
  "huggingface",
  "cloudflare",
  "workers-ai",
];

const STAGE_META = {
  gemini: {
    label: "Gemini",
    icon: "✦",
    tier: "primary",
    lane: "extract",
    requires: ["GEMINI_API_KEY"],
  },
  "ollama-7b": {
    label: "Ollama 7B (local, fast)",
    icon: "🏠",
    tier: "local",
    lane: "extract",
    requires: [],
    optionalEnv: ["OLLAMA_BASE_URL"],
    modelEnv: "OLLAMA_MODEL_7B",
    defaultModel: "qwen2.5:7b",
    note: "Local dev only — smaller/faster model, needs `ollama serve` at OLLAMA_BASE_URL",
  },
  "ollama-14b": {
    label: "Ollama 14B (local, quality)",
    icon: "🏠",
    tier: "local",
    lane: "extract",
    requires: [],
    optionalEnv: ["OLLAMA_BASE_URL"],
    modelEnv: "OLLAMA_MODEL_14B",
    defaultModel: "qwen2.5:14b",
    note: "Local dev only — larger/slower model, needs `ollama serve` at OLLAMA_BASE_URL. Benchmarked slower and less capable than ollama-30b on this same hardware — see docs/LOCAL_LLM_EXTRACTION.md.",
  },
  "ollama-30b": {
    label: "Ollama 30B-A3B (local, fastest solo)",
    icon: "🏠",
    tier: "local",
    lane: "extract",
    requires: [],
    optionalEnv: ["OLLAMA_BASE_URL"],
    modelEnv: "OLLAMA_MODEL_30B",
    defaultModel: "qwen3:30b-a3b",
    note: "Local dev only — Mixture-of-Experts (30B total/~3B active params/token). With OLLAMA_FLASH_ATTENTION=1 (recommended, see docs/LOCAL_LLM_EXTRACTION.md), this is the fastest local model measured for single-chapter extraction (~53 tok/s solo) — the default lead stage. Loses more of its speed under concurrency than ollama-20b, so prefer that one instead if VAE_EXTRACT_CONCURRENCY > 1. Needs `ollama serve` at OLLAMA_BASE_URL.",
  },
  "ollama-20b": {
    label: "Ollama GPT-OSS 20B (local, best for concurrency)",
    icon: "🏠",
    tier: "local",
    lane: "extract",
    requires: [],
    optionalEnv: ["OLLAMA_BASE_URL"],
    modelEnv: "OLLAMA_MODEL_20B",
    defaultModel: "gpt-oss:20b",
    note: "Local dev only — MoE (~20B total/~3.6B active params/token). Close second on solo speed to ollama-30b (~44 tok/s solo with OLLAMA_FLASH_ATTENTION=1), but by far the most concurrency-tolerant local model measured (~30 tok/s aggregate at 8-way concurrency vs. every other model losing 40-90% of its solo throughput). Prefer this one over ollama-30b if VAE_EXTRACT_CONCURRENCY > 1. Needs `ollama serve` at OLLAMA_BASE_URL. See docs/LOCAL_LLM_EXTRACTION.md.",
  },
  "mlx-30b": {
    label: "MLX Qwen3 30B-A3B (local, experimental — best measured for concurrency)",
    icon: "🍎",
    tier: "local",
    lane: "extract",
    requires: [],
    optionalEnv: ["MLX_BASE_URL"],
    modelEnv: "MLX_MODEL_30B",
    defaultModel: "mlx-community/Qwen3-30B-A3B-4bit",
    note: "Apple Silicon only — separate `mlx_lm.server` process (own Python venv, not `ollama serve`), gated behind MLX_BASE_URL exactly like OLLAMA_BASE_URL gates the ollama-* stages, additive/never replacing them. Loses badly on solo speed vs. ollama-30b+flash-attention (18.6 vs. 52.6 tok/s) but is the single best local combination measured for VAE_EXTRACT_CONCURRENCY > 1 (39.1 tok/s aggregate at 8-way concurrency, beating every Ollama config tested). Only worth enabling if you've deliberately raised VAE_EXTRACT_CONCURRENCY above 1. See docs/LOCAL_LLM_EXTRACTION.md.",
  },
  cerebras: {
    label: "Cerebras",
    icon: "⚡",
    tier: "freemium",
    lane: "extract",
    requires: ["CEREBRAS_API_KEY"],
    modelEnv: "CEREBRAS_EXTRACT_MODEL",
    defaultModel: "gpt-oss-120b",
  },
  groq: {
    label: "Groq",
    icon: "🦙",
    tier: "freemium",
    lane: "extract",
    requires: ["GROQ_API_KEY"],
    defaultModel: "llama-3.3-70b-versatile",
  },
  mistral: {
    label: "Mistral",
    icon: "🌬",
    tier: "freemium",
    lane: "extract",
    requires: ["MISTRAL_API_KEY"],
    defaultModel: "mistral-small-latest",
  },
  openrouter: {
    label: "OpenRouter",
    icon: "🔀",
    tier: "freemium",
    lane: "extract",
    requires: ["OPENROUTER_API_KEY"],
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
  },
  cloudflare: {
    label: "Workers AI",
    icon: "☁",
    tier: "freemium",
    lane: "extract",
    requires: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
    modelEnv: "CLOUDFLARE_EXTRACT_MODEL",
    defaultModel: "@cf/meta/llama-3.1-8b-instruct",
    note: "Late-chain fallback — shares 10k neurons/day with image FLUX",
  },
  gemini_image: {
    label: "Gemini Image",
    icon: "✦",
    tier: "primary",
    lane: "image",
    requires: ["GEMINI_API_KEY"],
    note: "Highest-quality default when a key is set. Full i2i support — up to "
      + "3 reference images (crops/uploads) are sent inline as multimodal image "
      + "parts alongside the text prompt, no separate IP-Adapter setup needed.",
  },
  freemium_image: {
    label: "Freemium APIs",
    icon: "🆓",
    tier: "freemium",
    lane: "image",
    requires: [],
    note: "A chain of free/low-cost cloud providers, tried in order — see the "
      + "\"image_freemium_character\"/\"image_freemium_background\" lanes below "
      + "to reorder that inner chain. Pollinations auto-upgrades to its i2i "
      + "(image-to-image) endpoint whenever a character has reference "
      + "images/crops available; Hugging Face and Workers AI are text-only, no "
      + "reference-image conditioning.",
  },
  local_sd: {
    label: "Local SD",
    icon: "🖥",
    tier: "local",
    lane: "image",
    requires: [],
    optionalEnv: ["LOCAL_IMAGE_URL"],
    note: "Self-hosted SDXL/SD1.5 server (scripts/local-image-server/server.py, "
      + "see docs/LOCAL_IMAGE_GEN.md) — one of three model profiles runs at a "
      + "time, picked via LOCAL_IMAGE_MODEL: "
      + "sdxl-turbo (2 steps, fastest, but base-SDXL photoreal training fights "
      + "anime prompts — no i2i, turbo's guidance_scale=0 strips the mechanism "
      + "IP-Adapter needs); "
      + "animagine-xl (28 steps, anime-native training + real CFG, best anime "
      + "fidelity, ~20-25x slower than turbo — i2i via IP-Adapter reference "
      + "crops, the profile this book uses); "
      + "sd15-anime-lcm (6 steps via LCM-LoRA, anime-native and close to turbo "
      + "speed — also has i2i via IP-Adapter). "
      + "Only animagine-xl and sd15-anime-lcm accept reference_image_b64.",
  },
  "pollinations-anon": {
    label: "Pollinations (free)",
    icon: "🌸",
    tier: "freemium",
    lane: "image_freemium",
    requires: [],
    note: "Unauthenticated flux, 0 cost, no rate-limit tier — the always-available "
      + "fallback. Auto-upgrades to i2i (image param, a reference URL) when a "
      + "character has reference images available.",
  },
  "pollinations-seed": {
    label: "Pollinations (seed)",
    icon: "🌺",
    tier: "freemium",
    lane: "image_freemium",
    requires: ["POLLINATIONS_TOKEN"],
    note: "Authenticated tier (costs pollen when balance > 0) — same i2i "
      + "auto-upgrade as the free tier, plus access to the kontext/seedream/klein "
      + "i2i models (POLLINATIONS_I2I_MODEL) not available unauthenticated.",
  },
  huggingface: {
    label: "Hugging Face",
    icon: "🤗",
    tier: "freemium",
    lane: "image_freemium",
    requires: [],
    optionalEnv: ["HF_TOKEN", "FAL_KEY", "FAL_AI_API_KEY"],
    modelEnv: "HF_IMAGE_MODEL",
    defaultModel: "black-forest-labs/FLUX.1-schnell",
    note: "Text-to-image only, no reference-image conditioning. Tries the HF "
      + "Inference router first, then a direct fal.ai call if FAL_KEY is set.",
  },
  "workers-ai": {
    label: "Workers AI (FLUX)",
    icon: "☁",
    tier: "freemium",
    lane: "image_freemium",
    requires: [],
    defaultModel: "@cf/black-forest-labs/flux-1-schnell",
    note: "Edge AI binding — last resort; shares 10k neurons/day with extract. "
      + "Text-to-image only, no reference-image conditioning.",
  },
};

const GEMINI_TEXT_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
const GEMINI_IMAGE_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
];

function laneDefault(lane) {
  const map = {
    extract: {
      order: ["ollama-30b", "ollama-20b", "ollama-7b", "ollama-14b", "mlx-30b", "gemini", "cerebras", "groq", "mistral", "openrouter", "cloudflare"],
      // mlx-30b is NOT listed here — it's disabled purely via the
      // MLX_BASE_URL gate below (same pattern as ollama-20b/30b/7b), so it
      // actually turns on once that env var is set. ollama-14b stays
      // default-disabled regardless (benchmarked strictly worse — see docs).
      disabled: ["ollama-14b"],
    },
    image: { order: ["gemini_image", "freemium_image", "local_sd"], disabled: [] },
    image_freemium_character: { order: [...IMAGE_FREEMIUM_DEFAULT], disabled: [] },
    image_freemium_background: { order: [...IMAGE_FREEMIUM_DEFAULT], disabled: [] },
    gemini_text: { order: [...GEMINI_TEXT_MODELS], disabled: [] },
    gemini_image_models: { order: [...GEMINI_IMAGE_MODELS], disabled: [] },
  };
  return map[lane] || { order: [], disabled: [] };
}

export function defaultConfig(env = {}) {
  const cfg = {
    extract: laneDefault("extract"),
    image: laneDefault("image"),
    image_freemium_character: laneDefault("image_freemium_character"),
    image_freemium_background: laneDefault("image_freemium_background"),
    gemini_text: laneDefault("gemini_text"),
    gemini_image_models: laneDefault("gemini_image_models"),
  };
  if (String(env.EXTRACT_SKIP_GEMINI ?? "true").toLowerCase() === "true") {
    cfg.extract.disabled = [...new Set([...(cfg.extract.disabled || []), "gemini"])];
  }
  // Ollama only makes sense when a local dev server is configured — never in production.
  if (!String(env.OLLAMA_BASE_URL || "").trim()) {
    cfg.extract.disabled = [...new Set([...(cfg.extract.disabled || []), "ollama-20b", "ollama-30b", "ollama-7b", "ollama-14b"])];
  }
  // MLX is an additive, Apple-Silicon-only local backend — same hard gate as
  // Ollama above, never enabled in production and never by default even
  // locally (opt-in only once MLX_BASE_URL is set — see docs/LOCAL_LLM_EXTRACTION.md).
  if (!String(env.MLX_BASE_URL || "").trim()) {
    cfg.extract.disabled = [...new Set([...(cfg.extract.disabled || []), "mlx-30b"])];
  }
  return cfg;
}

function mergeLane(base, override) {
  if (!override) return base;
  const out = { ...base, order: [...base.order], disabled: [...(base.disabled || [])] };
  if (Array.isArray(override.order)) {
    const seen = new Set();
    const merged = [];
    for (const sid of override.order) {
      if (seen.has(sid) || !base.order.includes(sid)) continue;
      seen.add(sid);
      merged.push(sid);
    }
    for (const sid of base.order) {
      if (!seen.has(sid)) merged.push(sid);
    }
    out.order = merged;
  }
  if (Array.isArray(override.disabled)) {
    out.disabled = override.disabled.filter((x) => typeof x === "string");
  }
  return out;
}

export async function loadConfig(env) {
  const base = defaultConfig(env);
  if (!env.VAE_JOBS) return { cfg: base, persisted: false };
  const raw = await env.VAE_JOBS.get(KV_KEY);
  if (!raw) return { cfg: base, persisted: false };
  try {
    const patch = JSON.parse(raw);
    if (!patch || typeof patch !== "object") return { cfg: base, persisted: false };
    for (const lane of Object.keys(base)) {
      base[lane] = mergeLane(base[lane], patch[lane]);
    }
    return { cfg: base, persisted: true };
  } catch {
    return { cfg: base, persisted: false };
  }
}

export async function getConfig(env) {
  return (await loadConfig(env)).cfg;
}

export async function saveConfig(env, patch) {
  const { cfg } = await loadConfig(env);
  for (const [lane, body] of Object.entries(patch || {})) {
    if (!cfg[lane] || typeof body !== "object") continue;
    cfg[lane] = mergeLane(cfg[lane], body);
  }
  if (env.VAE_JOBS) {
    await env.VAE_JOBS.put(KV_KEY, JSON.stringify(cfg));
  }
  return cfg;
}

function envPresent(env, key) {
  return Boolean(String(env[key] || "").trim());
}

export function stageAvailable(env, stageId) {
  const meta = STAGE_META[stageId];
  if (!meta) {
    if (stageId.startsWith("gemini")) return envPresent(env, "GEMINI_API_KEY");
    return true;
  }
  for (const req of meta.requires || []) {
    if (!envPresent(env, req)) return false;
  }
  if (stageId === "freemium_image") {
    if (String(env.DISABLE_FREEMIUM_IMAGE || "").toLowerCase() === "true") return false;
  }
  if (stageId === "huggingface") {
    return envPresent(env, "HF_TOKEN") || envPresent(env, "FAL_KEY") || envPresent(env, "FAL_AI_API_KEY");
  }
  if (stageId === "workers-ai") {
    return Boolean(env.AI);
  }
  if (stageId === "local_sd") return envPresent(env, "LOCAL_IMAGE_URL");
  return true;
}

export async function resolvedOrder(env, lane, prefer = null) {
  const cfg = await getConfig(env);
  const laneDef = cfg[lane] || { order: [], disabled: [] };
  const disabled = new Set(laneDef.disabled || []);
  let order = (laneDef.order || []).filter((sid) => !disabled.has(sid));
  if (prefer && order.includes(prefer)) {
    order = [prefer, ...order.filter((p) => p !== prefer)];
  }
  return order;
}

export async function resolvedExtractProviders(env, prefer = null) {
  return resolvedOrder(env, "extract", prefer);
}

export async function resolvedFreemiumImageChain(env, subjectType, prefer = null) {
  const lane = subjectType === "background" ? "image_freemium_background" : "image_freemium_character";
  return resolvedOrder(env, lane, prefer);
}

function laneTitle(lane) {
  const titles = {
    extract: "Text extraction",
    image: "Image generation tiers",
    image_freemium_character: "Character sprites (freemium)",
    image_freemium_background: "Backgrounds (freemium)",
    gemini_text: "Gemini text models",
    gemini_image_models: "Gemini image models",
  };
  return titles[lane] || lane;
}

export async function publicView(env) {
  const { cfg, persisted } = await loadConfig(env);
  const lanes = {};
  for (const [lane, laneDef] of Object.entries(cfg)) {
    const disabled = new Set(laneDef.disabled || []);
    const items = (laneDef.order || []).map((sid) => {
      const meta = STAGE_META[sid] || {
        label: sid,
        icon: "◇",
        tier: "model",
        lane,
      };
      let model = meta.defaultModel || null;
      if (meta.modelEnv && env[meta.modelEnv]) model = env[meta.modelEnv];
      return {
        id: sid,
        label: meta.label || sid,
        icon: meta.icon || "◇",
        tier: meta.tier || "model",
        enabled: !disabled.has(sid),
        available: stageAvailable(env, sid),
        model,
        note: meta.note || null,
      };
    });
    lanes[lane] = { title: laneTitle(lane), items };
  }
  const cost_guide = evaluateCostEfficiency(cfg, env);
  const local_extract_guide = {
    presets: LOCAL_EXTRACT_PRESETS,
    active: activeLocalExtractPreset(cfg),
    ollamaConfigured: Boolean(String(env.OLLAMA_BASE_URL || "").trim()),
    mlxConfigured: Boolean(String(env.MLX_BASE_URL || "").trim()),
  };
  return {
    lanes, config: cfg, source: persisted ? "edge-kv" : "edge-defaults", cost_guide, local_extract_guide,
  };
}
